/**
 * Persistence abstraction for user-imported game plugins. Built-in games
 * (shipped under `backend/src/games/`) stay on local disk — they're
 * source-controlled server content, read once at boot, and identified by their
 * folder name. An *imported* plugin is user data, and a node's local disk is
 * the wrong home for it: it doesn't survive a restart on an ephemeral
 * filesystem and isn't shared across nodes in a multi-node deployment.
 * `PluginRepository` follows the same `InMemory*`/`Mongo*`-behind-one-interface
 * shape as `MatchRepository` and `UserRepository` so imported plugins get the
 * same durability guarantee.
 *
 * **The store assigns the id.** `rules.json` carries no `gameId` (see
 * `RulesDsl`), so `create` is the only thing that mints one and it hands back
 * the record it stored. That is what lets the same rules.json be imported
 * twice as two independent games, and stops an author from choosing an id that
 * collides with — or silently replaces — somebody else's game.
 */

import { randomUUID } from 'node:crypto';
import type { RulesDsl } from '@hcg/shared';

export interface StoredPlugin {
  /** Assigned by the repository on `create`; never authored in rules.json. */
  readonly gameId: string;
  readonly rules: RulesDsl;
  readonly strategy: string;
  readonly ownerUserId: string;
  readonly updatedAt: Date;
}

/** A plugin's content, without the identity the store has yet to assign. */
export type PluginContent = Omit<StoredPlugin, 'gameId'>;

export interface PluginRepository {
  /** Inserts under a freshly minted id and returns the stored record. */
  create(plugin: PluginContent): Promise<StoredPlugin>;
  /** Replaces an existing record's content in place. No-op if the id is unknown. */
  update(gameId: string, plugin: PluginContent): Promise<void>;
  findById(gameId: string): Promise<StoredPlugin | null>;
  findByOwner(ownerUserId: string): Promise<StoredPlugin[]>;
  delete(gameId: string): Promise<void>;
}

export class InMemoryPluginRepository implements PluginRepository {
  private readonly store = new Map<string, StoredPlugin>();

  async create(plugin: PluginContent): Promise<StoredPlugin> {
    const stored: StoredPlugin = { ...plugin, gameId: randomUUID() };
    this.store.set(stored.gameId, stored);
    return stored;
  }

  async update(gameId: string, plugin: PluginContent): Promise<void> {
    if (!this.store.has(gameId)) return;
    this.store.set(gameId, { ...plugin, gameId });
  }

  async findById(gameId: string): Promise<StoredPlugin | null> {
    return this.store.get(gameId) ?? null;
  }

  async findByOwner(ownerUserId: string): Promise<StoredPlugin[]> {
    return [...this.store.values()].filter((p) => p.ownerUserId === ownerUserId);
  }

  async delete(gameId: string): Promise<void> {
    this.store.delete(gameId);
  }
}
