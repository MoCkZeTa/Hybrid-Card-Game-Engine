/**
 * Dynamic plugin loader (PRD 2, "Plugin & DSL Engine" / directive 7).
 *
 * Scans `src/games/<id>/` at boot, reads `rules.json` + `strategy.md`, and
 * validates the DSL before the game is registered. A malformed plugin must
 * never reach runtime — PRD 6 requires the boot stage to "fail fast on
 * invalid JSON DSL" rather than let a bad config surface mid-match.
 *
 * **Where an id comes from.** `rules.json` carries none (see `RulesDsl`). A
 * built-in is identified by its **folder name** — stable across restarts and
 * redeploys, which is what keeps a persisted match record resolving after the
 * server comes back. An imported plugin is identified by an id the
 * `PluginRepository` mints on insert. The two spaces don't overlap in practice
 * (a folder is named `callbreak`, a minted id is a UUID or ObjectId hex), and
 * `loadAll` fails fast if a repository id ever shadowed a built-in.
 *
 * **Built-ins are immutable.** The games shipped under `src/games/` are the
 * server's default catalog: no user may edit or delete them. Customising one
 * is a *fork* — read its source, change it, import it — which yields a private
 * copy with its own id and leaves the shipped original alone. Nothing in this
 * class writes to or removes anything from disk.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  handLimitBounds,
  resolveDeal,
  supportedPlayerCounts,
  validateRulesDsl,
  type GameSummary,
  type RulesDsl,
} from '@hcg/shared';
import type { PluginRepository, StoredPlugin } from './plugin-repository.js';

/** Ids that become URL path segments and database keys — no traversal, no separators. */
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Drops a leading UTF-8 byte-order mark. `JSON.parse` rejects one outright
 * ("Unexpected token '﻿'"), and editing `rules.json` by hand is a headline
 * feature — on Windows, Notepad and PowerShell's `Out-File`/`Set-Content` both
 * add a BOM by default, so a user's perfectly good rules file would come back
 * as "not valid JSON" with nothing visibly wrong with it.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export interface GamePlugin {
  /** Folder name for a built-in; a repository-minted id for an imported one. */
  readonly gameId: string;
  readonly rules: RulesDsl;
  /** Raw strategy guide text, compiled into the LLM system prompt as-is (PRD 3.2). */
  readonly strategy: string;
  /** Disk path for a built-in plugin; empty for a DB-backed imported one. */
  readonly sourceDir: string;
  /**
   * True when registered at runtime via `importPlugin`. False means built-in:
   * shipped, read-only, and undeletable. The two are exhaustive — there is no
   * longer any such thing as a disk-backed user import.
   */
  readonly imported: boolean;
  /**
   * User id of the importer, for a plugin persisted to `PluginRepository`.
   * `undefined` means public — a built-in game. Only a plugin with an owner is
   * private: visible and usable solely by that user.
   */
  readonly ownerUserId?: string;
}

export class PluginLoadError extends Error {
  constructor(
    public readonly gameDir: string,
    public readonly reasons: readonly string[],
  ) {
    super(`Failed to load game plugin at "${gameDir}":\n  - ${reasons.join('\n  - ')}`);
    this.name = 'PluginLoadError';
  }
}

/** Raised when a runtime-imported plugin fails validation. Carries per-field reasons for the UI. */
export class PluginImportError extends Error {
  constructor(public readonly reasons: readonly string[]) {
    super(`Plugin import rejected:\n  - ${reasons.join('\n  - ')}`);
    this.name = 'PluginImportError';
  }
}

/**
 * An attempt to edit or delete a built-in game. Distinct from a plain
 * `PluginImportError` so the route layer can answer 403 rather than 400 — the
 * request was well-formed, it is the target that is off limits.
 *
 * Extends `PluginImportError`, so existing `instanceof PluginImportError`
 * handlers still catch it; anything wanting the distinction must test for
 * this subclass first.
 */
export class PluginProtectedError extends PluginImportError {
  constructor(public readonly gameId: string) {
    super([
      `"${gameId}" is a built-in game and cannot be modified or deleted. Import a copy to make your own version of it.`,
    ]);
    this.name = 'PluginProtectedError';
  }
}

export class PluginManager {
  private readonly plugins = new Map<string, GamePlugin>();
  /** Folder-name ids of the shipped games — the set that may never be written to. */
  private readonly builtInIds = new Set<string>();
  private repository: PluginRepository | null = null;

  private constructor() {}

  /**
   * Scans `gamesRoot` for plugin subdirectories and loads all of them.
   * Throws `PluginLoadError` on the first invalid plugin — boot must not
   * proceed with a partially-loaded, silently-broken game catalog.
   *
   * `repository` backs user-imported plugins (see `plugin-repository.ts`) —
   * built-in games never touch it, they're read from `gamesRoot` alone.
   */
  static async loadAll(gamesRoot: string, repository: PluginRepository): Promise<PluginManager> {
    const manager = new PluginManager();
    manager.repository = repository;
    let entries: string[];
    try {
      entries = await readdir(gamesRoot);
    } catch (err) {
      throw new Error(`Cannot read games directory "${gamesRoot}": ${(err as Error).message}`);
    }

    for (const entry of entries) {
      const dir = path.join(gamesRoot, entry);
      const info = await stat(dir);
      if (!info.isDirectory()) continue;
      const plugin = await manager.loadOne(dir);
      manager.plugins.set(plugin.gameId, plugin);
      manager.builtInIds.add(plugin.gameId);
    }

    if (manager.plugins.size === 0) {
      throw new Error(`No valid game plugins found under "${gamesRoot}"`);
    }
    return manager;
  }

  /** True for a shipped game: read-only, undeletable, visible to everyone. */
  isBuiltIn(gameId: string): boolean {
    return this.builtInIds.has(gameId);
  }

  private async loadOne(dir: string): Promise<GamePlugin> {
    // The folder name *is* the id, so it has to be a legal one — it ends up in
    // URL paths and match records. Caught at boot, where a bad name is a
    // deployment mistake someone can fix, rather than at request time.
    const gameId = path.basename(dir);
    if (!ID_PATTERN.test(gameId)) {
      throw new PluginLoadError(dir, [
        `folder name "${gameId}" is not a usable game id — use only letters, digits, dot, dash or underscore, starting with a letter or digit`,
      ]);
    }

    const rulesPath = path.join(dir, 'rules.json');
    const strategyPath = path.join(dir, 'strategy.md');

    const [rulesRaw, strategy] = await Promise.all([
      readFile(rulesPath, 'utf-8').catch(() => {
        throw new PluginLoadError(dir, [`missing or unreadable rules.json at "${rulesPath}"`]);
      }),
      readFile(strategyPath, 'utf-8').catch(() => {
        throw new PluginLoadError(dir, [`missing or unreadable strategy.md at "${strategyPath}"`]);
      }),
    ]);

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripBom(rulesRaw));
    } catch (err) {
      throw new PluginLoadError(dir, [`rules.json is not valid JSON: ${(err as Error).message}`]);
    }

    const result = validateRulesDsl(parsed);
    if (!result.valid) {
      throw new PluginLoadError(dir, result.errors);
    }

    const rules = parsed as RulesDsl;
    if (strategy.trim().length === 0) {
      throw new PluginLoadError(dir, ['strategy.md is empty']);
    }

    return { gameId, rules, strategy, sourceDir: dir, imported: false };
  }

  /**
   * Internal, in-memory-only lookup — used by callers that already hold a
   * matchId's own plugin reference or are reconstructing one during failover
   * (`adopt()`), where hitting the database would be both unnecessary and
   * unsafe to await from a sync call site. Never exposed to a user-driven,
   * gameId-by-string request — use `getVisible` for that, which enforces
   * ownership and won't leak the full registry in its error.
   */
  get(gameId: string): GamePlugin {
    const plugin = this.plugins.get(gameId);
    if (!plugin) {
      throw new Error(`Unknown gameId "${gameId}". Registered: [${[...this.plugins.keys()].join(', ')}]`);
    }
    return plugin;
  }

  has(gameId: string): boolean {
    return this.plugins.has(gameId);
  }

  list(): readonly GamePlugin[] {
    return [...this.plugins.values()];
  }

  /**
   * The single read path for resolving a plugin a specific user is trying to
   * act on (create a match, view/edit/delete its source) — mirrors
   * `AuthService.validateToken`'s cache-then-repository shape: check the
   * in-memory cache first, and only on a miss consult the durable store,
   * caching the result for next time. A private plugin (`ownerUserId` set)
   * is only ever returned to its owner; everyone else gets the same
   * "unknown gameId" error a truly nonexistent id would produce, so a denied
   * caller can't distinguish "doesn't exist" from "exists but isn't yours" —
   * and, unlike `get()`, this error never lists the registry, so it can't
   * leak the existence of other users' private game ids.
   */
  async getVisible(gameId: string, userId: string): Promise<GamePlugin> {
    const cached = this.plugins.get(gameId);
    if (cached && (cached.ownerUserId === undefined || cached.ownerUserId === userId)) {
      return cached;
    }
    if (cached) throw new Error(`Unknown gameId "${gameId}"`);

    if (!this.repository) throw new Error(`Unknown gameId "${gameId}"`);
    const stored = await this.repository.findById(gameId);
    if (!stored || stored.ownerUserId !== userId) throw new Error(`Unknown gameId "${gameId}"`);

    const plugin = toGamePlugin(stored);
    this.plugins.set(gameId, plugin);
    return plugin;
  }

  /**
   * Client-facing catalog, derived from each plugin's own rules.json. Built-in
   * games come straight from the in-memory map (no DB call); when `userId` is
   * given, that user's own imported plugins are also pulled in — via one
   * indexed query against the repository, cached as a side effect — so the
   * catalog is always complete regardless of which server node loaded them.
   * `LIST_GAMES` only fires once per connection and on a manual refresh (never
   * polled), so this one query per call is cheap.
   */
  async summaries(userId?: string): Promise<GameSummary[]> {
    if (userId && this.repository) {
      const owned = await this.repository.findByOwner(userId);
      for (const stored of owned) this.plugins.set(stored.gameId, toGamePlugin(stored));
    }

    const summaries: GameSummary[] = [];
    for (const plugin of this.list()) {
      if (plugin.ownerUserId !== undefined && plugin.ownerUserId !== userId) continue;
      // One unreadable plugin must not cost the player their whole catalog.
      // These helpers assume rules that passed validation, and a stored plugin
      // predating a DSL change may no longer satisfy them — dropping that one
      // game (loudly, in the log) beats an empty lobby with no built-ins in it.
      try {
        summaries.push(toSummary(plugin));
      } catch (err) {
        console.warn(`[plugins] skipping "${plugin.gameId}" — its rules could not be summarised: ${(err as Error).message}`);
      }
    }
    return summaries;
  }

  /**
   * Validates a plugin supplied at runtime and stores it as a **new** game
   * under an id the repository mints. Rejects anything `validateRulesDsl`
   * refuses, exactly as boot-time loading does — an imported plugin gets no
   * weaker a guarantee than a shipped one.
   *
   * Import always creates. Sending the same rules.json twice yields two
   * independent games rather than a conflict, because nothing in the document
   * claims an identity any more. Changing an existing plugin is `updatePlugin`,
   * which names its target in the request instead of inferring it.
   */
  async importPlugin(rawRules: unknown, strategy: string, requestingUserId: string): Promise<GamePlugin> {
    const rules = this.validateContent(rawRules, strategy);

    if (!this.repository) {
      throw new PluginImportError(['Plugin import is unavailable: this manager was created without a repository']);
    }
    const stored = await this.repository.create({
      rules,
      strategy,
      ownerUserId: requestingUserId,
      updatedAt: new Date(),
    });

    const plugin = toGamePlugin(stored);
    this.plugins.set(plugin.gameId, plugin);
    return plugin;
  }

  /**
   * Replaces an existing imported plugin's rules and strategy, keeping its id
   * — so rooms, match records and decision logs that reference it stay valid.
   *
   * Owner-only, and re-checked against the repository (the authoritative
   * source) rather than this node's cache. A built-in is refused outright: the
   * shipped catalog is read-only, and the way to customise one is to import a
   * copy. A match already in progress keeps its own reference to the plugin it
   * was created with, so this never disrupts a live game.
   */
  async updatePlugin(
    gameId: string,
    rawRules: unknown,
    strategy: string,
    requestingUserId: string,
  ): Promise<GamePlugin> {
    if (this.isBuiltIn(gameId)) throw new PluginProtectedError(gameId);

    const rules = this.validateContent(rawRules, strategy);
    if (!this.repository) {
      throw new PluginImportError(['Plugin editing is unavailable: this manager was created without a repository']);
    }

    const stored = await this.repository.findById(gameId);
    if (!stored) throw new Error(`Unknown gameId "${gameId}"`);
    if (stored.ownerUserId !== requestingUserId) {
      throw new PluginImportError(['Only the importer may edit this plugin']);
    }

    const content = { rules, strategy, ownerUserId: stored.ownerUserId, updatedAt: new Date() };
    await this.repository.update(gameId, content);

    const plugin = toGamePlugin({ ...content, gameId });
    this.plugins.set(gameId, plugin);
    return plugin;
  }

  /**
   * Removes an imported plugin. Owner-only, re-checked against the repository
   * (the authoritative source, not just this node's cache).
   *
   * A built-in is refused: 29 and Callbreak are the server's default catalog
   * and no user may remove them. A match already in progress keeps its own
   * reference to the plugin it was created with, so deleting one never
   * disrupts a live game — it only prevents *new* matches of it.
   */
  async deletePlugin(gameId: string, requestingUserId: string): Promise<void> {
    if (this.isBuiltIn(gameId)) throw new PluginProtectedError(gameId);

    if (!this.repository) throw new Error(`Unknown gameId "${gameId}"`);
    const stored = await this.repository.findById(gameId);
    if (!stored) throw new Error(`Unknown gameId "${gameId}"`);
    if (stored.ownerUserId !== requestingUserId) {
      throw new PluginImportError(['Only the importer may delete this plugin']);
    }
    await this.repository.delete(gameId);
    this.plugins.delete(gameId);
  }

  /** Shared validation for the two write paths — a rules blob plus its strategy guide. */
  private validateContent(rawRules: unknown, strategy: string): RulesDsl {
    const result = validateRulesDsl(rawRules);
    if (!result.valid) throw new PluginImportError(result.errors);
    if (!strategy.trim()) throw new PluginImportError(['strategy.md content must not be empty']);
    return rawRules as RulesDsl;
  }
}

function toGamePlugin(stored: StoredPlugin): GamePlugin {
  return {
    gameId: stored.gameId,
    rules: stored.rules,
    strategy: stored.strategy,
    sourceDir: '',
    imported: true,
    ownerUserId: stored.ownerUserId,
  };
}

/** The client-facing shape of one plugin, derived entirely from its own rules. */
function toSummary(plugin: GamePlugin): GameSummary {
  const counts = supportedPlayerCounts(plugin.rules);
  const handSizeByCount: Record<string, number> = {};
  for (const n of counts) handSizeByCount[String(n)] = resolveDeal(plugin.rules, n).handSize;

  return {
    gameId: plugin.gameId,
    displayName: plugin.rules.displayName,
    playerCounts: counts,
    defaultPlayerCount: plugin.rules.players.defaultCount,
    topology: plugin.rules.players.topology,
    handSizeByCount,
    trumpMode: plugin.rules.trump.mode,
    hasBidding: Boolean(plugin.rules.bidding?.enabled),
    handLimit: handLimitBounds(plugin.rules),
    imported: plugin.imported,
  };
}
