/**
 * Plugin import endpoint.
 *
 * GET    /api/plugins           -> 200 { games: GameSummary[] }
 * GET    /api/plugins/:gameId   -> 200 { gameId, rules, strategy, imported, builtIn }
 * POST   /api/plugins           { rules: object | string, strategy: string }
 *   -> 201 { game: GameSummary }   always creates, under a server-assigned id
 *   -> 400 { error, reasons[] }    when the DSL fails validation
 * PUT    /api/plugins/:gameId   { rules: object | string, strategy: string }
 *   -> 200 { game: GameSummary }   replaces content, keeps the id
 *   -> 403 { error, reasons[], code: 'GAME_PROTECTED' }  target is built-in
 * DELETE /api/plugins/:gameId   -> 200 { ok: true }
 *   -> 403 { error, reasons[], code: 'GAME_PROTECTED' }  target is built-in
 *
 * Lets a new game be added from the browser without touching the server — the
 * plugin is validated exactly as a boot-time one is, persisted so it survives
 * a restart, and registered immediately.
 *
 * **Create and edit are different verbs.** `rules.json` no longer carries a
 * `gameId`, so POST has no identity to collide with: it always inserts, and
 * the same file imported twice becomes two independent games. Editing names
 * its target in the URL instead.
 *
 * **Built-in games (29, Callbreak) are immutable.** They're the server's
 * default catalog — no user may edit or delete them, and PUT/DELETE answer 403.
 * Customising one is a fork: GET its source, change it, POST it back as your
 * own private copy.
 *
 * An *imported* plugin is private to its importer: it's persisted via
 * `PluginRepository` (durable storage, not this node's local disk) and only its
 * owner can see it in the catalog, view/edit/delete it, or create new matches
 * of it — everyone else gets the same "unknown gameId" response a nonexistent
 * game would produce. A friend can still join and play a specific match through
 * its shared match code without ever needing visibility into the plugin itself.
 *
 * Every write (create, edit, delete) requires authentication; reading a single
 * plugin's raw content does too, since it's only needed by the edit UI for a
 * signed-in user. The collection listing accepts an optional token so a
 * signed-in caller's own private plugins are included.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthService } from '../core/auth/auth-service.js';
import {
  PluginImportError,
  PluginProtectedError,
  stripBom,
  type PluginManager,
} from '../core/plugin/plugin-manager.js';
import { resolveCorsOrigin } from './cors.js';

const MAX_BODY_BYTES = 512 * 1024; // plugins are small; cap well below anything abusive

export function createPluginHandler(
  plugins: PluginManager,
  authService: AuthService,
  allowedOrigin: string,
  isProduction: boolean,
) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = (req.url ?? '').split('?')[0];
    const isCollection = url === '/api/plugins';
    const itemMatch = url?.match(/^\/api\/plugins\/([^/]+)$/);
    if (!isCollection && !itemMatch) return false;

    res.setHeader('Access-Control-Allow-Origin', resolveCorsOrigin(req, allowedOrigin, isProduction));
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return true;
    }

    if (isCollection && req.method === 'GET') {
      const token = bearerToken(req);
      const user = token ? await authService.validateToken(token) : null;
      json(res, 200, { games: await plugins.summaries(user?.id) });
      return true;
    }

    if (itemMatch && req.method === 'GET') {
      const token = bearerToken(req);
      const user = token ? await authService.validateToken(token) : null;
      if (!user) {
        json(res, 401, { error: 'Sign in to view plugin source' });
        return true;
      }
      try {
        const gameId = decodeURIComponent(itemMatch[1]!);
        const plugin = await plugins.getVisible(gameId, user.id);
        json(res, 200, {
          gameId: plugin.gameId,
          rules: plugin.rules,
          strategy: plugin.strategy,
          imported: plugin.imported,
          // Lets the edit UI offer "fork" rather than "save" without having to
          // attempt a PUT and interpret the 403.
          builtIn: plugins.isBuiltIn(gameId),
        });
      } catch (err) {
        json(res, 404, { error: (err as Error).message });
      }
      return true;
    }

    if (itemMatch && req.method === 'PUT') {
      const token = bearerToken(req);
      const user = token ? await authService.validateToken(token) : null;
      if (!user) {
        json(res, 401, { error: 'Sign in to edit a plugin' });
        return true;
      }
      const gameId = decodeURIComponent(itemMatch[1]!);
      try {
        const body = await readJson(req);
        const rules = parseRules(body.rules);
        if (rules.error) {
          json(res, 400, { error: rules.error, reasons: rules.reasons });
          return true;
        }
        const strategy = typeof body.strategy === 'string' ? body.strategy : '';
        const plugin = await plugins.updatePlugin(gameId, rules.value, strategy, user.id);
        const summary = (await plugins.summaries(user.id)).find((g) => g.gameId === plugin.gameId);
        console.log(`[plugins] "${plugin.gameId}" edited by ${user.displayName}`);
        json(res, 200, { game: summary });
      } catch (err) {
        respondToWriteError(res, err);
      }
      return true;
    }

    if (itemMatch && req.method === 'DELETE') {
      const token = bearerToken(req);
      const user = token ? await authService.validateToken(token) : null;
      if (!user) {
        json(res, 401, { error: 'Sign in to delete a plugin' });
        return true;
      }
      try {
        await plugins.deletePlugin(decodeURIComponent(itemMatch[1]!), user.id);
        console.log(`[plugins] "${itemMatch[1]}" deleted by ${user.displayName}`);
        json(res, 200, { ok: true });
      } catch (err) {
        respondToWriteError(res, err);
      }
      return true;
    }

    if (!isCollection || req.method !== 'POST') {
      json(res, 405, { error: 'Method not allowed' });
      return true;
    }

    const token = bearerToken(req);
    const user = token ? await authService.validateToken(token) : null;
    if (!user) {
      json(res, 401, { error: 'Sign in to import a plugin' });
      return true;
    }

    try {
      const body = await readJson(req);
      const rules = parseRules(body.rules);
      if (rules.error) {
        json(res, 400, { error: rules.error, reasons: rules.reasons });
        return true;
      }

      const strategy = typeof body.strategy === 'string' ? body.strategy : '';
      const plugin = await plugins.importPlugin(rules.value, strategy, user.id);
      const summary = (await plugins.summaries(user.id)).find((g) => g.gameId === plugin.gameId);
      console.log(`[plugins] "${plugin.gameId}" imported by ${user.displayName}`);
      json(res, 201, { game: summary });
      return true;
    } catch (err) {
      respondToWriteError(res, err);
      return true;
    }
  };
}

/**
 * `rules` may arrive as an object or as the raw text of a rules.json file —
 * the UI has a paste box, so accept both.
 */
function parseRules(raw: unknown): { value?: unknown; error?: string; reasons?: string[] } {
  let rules = raw;
  if (typeof rules === 'string') {
    try {
      rules = JSON.parse(stripBom(rules));
    } catch (err) {
      return { error: 'rules.json is not valid JSON', reasons: [(err as Error).message] };
    }
  }
  if (rules === undefined || rules === null) {
    return { error: 'Missing "rules"', reasons: ['Provide the contents of rules.json'] };
  }
  return { value: rules };
}

/**
 * One error shape for every write verb. Subclass first: a protected built-in is
 * a 403 the caller can never retry, not a 400 they should try to fix.
 */
function respondToWriteError(res: ServerResponse, err: unknown): void {
  if (err instanceof PluginProtectedError) {
    json(res, 403, { error: 'Plugin rejected', reasons: err.reasons, code: 'GAME_PROTECTED', gameId: err.gameId });
  } else if (err instanceof PluginImportError) {
    json(res, 400, { error: 'Plugin rejected', reasons: err.reasons });
  } else if (/^Unknown gameId/.test((err as Error).message)) {
    json(res, 404, { error: (err as Error).message });
  } else {
    console.error('[plugins] write failed:', err);
    json(res, 500, { error: (err as Error).message });
  }
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>;
  } catch {
    throw new Error('Request body was not valid JSON');
  }
}
