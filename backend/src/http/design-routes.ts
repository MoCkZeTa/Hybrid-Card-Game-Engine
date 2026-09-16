/**
 * AI game-designer endpoints.
 *
 * GET    /api/design                          -> 200 DesignAvailability
 * GET    /api/design/sessions                 -> 200 { sessions: DesignSessionSummary[] }
 * POST   /api/design/sessions      { brief }  -> 201 { session: DesignSessionDetail }
 * GET    /api/design/sessions/:id             -> 200 { session }
 * DELETE /api/design/sessions/:id             -> 200 { ok: true }
 * POST   /api/design/sessions/:id/refine   { brief }             -> 200 { session }
 * PUT    /api/design/sessions/:id/draft    { rules, strategy }   -> 200 { session }
 * POST   /api/design/sessions/:id/revert   { n }                 -> 200 { session }
 * POST   /api/design/sessions/:id/publish                        -> 200 { session, gameId }
 *
 * Every route needs a signed-in user; a design session is private to its
 * author exactly as an imported plugin is, and someone else's id answers 404
 * rather than 403 so the endpoint cannot be used to probe for sessions.
 *
 * `GET /api/design` is the one route that answers without a session of its
 * own: it reports whether the feature is configured at all. The designer needs
 * a generative model and has no `legal_moves[0]` to fall back on, so a server
 * with no API key must say so up front rather than let the UI offer a button
 * that always fails.
 *
 * The three routes that call the model are throttled per user (`DESIGN_RULE`);
 * the rest are ordinary database reads and are not.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthService } from '../core/auth/auth-service.js';
import type { AuthUser } from '@hcg/shared';
import {
  DesignLimitError,
  DesignNotFoundError,
  DesignNotPublishableError,
  type DesignService,
} from '../core/authoring/design-service.js';
import { DesignError } from '../core/authoring/game-designer.js';
import { PluginImportError } from '../core/plugin/plugin-manager.js';
import { DESIGN_RULE, type RateLimiter } from '../core/ratelimit/rate-limiter.js';
import { resolveCorsOrigin } from './cors.js';

/** A hand-edited draft can be a whole rules.json plus a strategy guide; still small. */
const MAX_BODY_BYTES = 512 * 1024;

export interface DesignHandlerOptions {
  /**
   * Null when no LLM is configured. The routes still mount — `GET /api/design`
   * has to be able to answer "unavailable, and here is why" — but every route
   * that would draft answers 503 with the same reason.
   */
  readonly service: DesignService | null;
  readonly unavailableReason?: string;
  readonly authService: AuthService;
  readonly allowedOrigin: string;
  readonly isProduction: boolean;
  readonly rateLimiter: RateLimiter;
}

export function createDesignHandler(opts: DesignHandlerOptions) {
  const { service, authService, allowedOrigin, isProduction, rateLimiter } = opts;

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = (req.url ?? '').split('?')[0] ?? '';
    if (url !== '/api/design' && !url.startsWith('/api/design/')) return false;

    res.setHeader('Access-Control-Allow-Origin', resolveCorsOrigin(req, allowedOrigin, isProduction));
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return true;
    }

    // Availability is public: the client asks before rendering the feature, and
    // it reveals nothing beyond whether this deployment has an LLM key.
    if (url === '/api/design' && req.method === 'GET') {
      json(res, 200, {
        available: service !== null,
        ...(service
          ? { model: service.modelLabel }
          : { reason: opts.unavailableReason ?? 'the AI game designer is not configured on this server' }),
      });
      return true;
    }

    const user = await authenticate(req, authService);
    if (!user) {
      json(res, 401, { error: 'Sign in to use the game designer' });
      return true;
    }

    if (!service) {
      json(res, 503, {
        error: `The AI game designer is unavailable: ${opts.unavailableReason ?? 'not configured on this server'}`,
      });
      return true;
    }

    const collection = url === '/api/design/sessions';
    const item = url.match(/^\/api\/design\/sessions\/([^/]+)$/);
    const action = url.match(/^\/api\/design\/sessions\/([^/]+)\/(refine|draft|revert|publish)$/);

    try {
      if (collection && req.method === 'GET') {
        json(res, 200, { sessions: await service.list(user.id) });
        return true;
      }

      if (collection && req.method === 'POST') {
        if (await throttled(res, rateLimiter, user)) return true;
        const body = await readJson(req);
        const session = await service.createSession(user.id, String(body.brief ?? ''));
        console.log(`[design] session ${session.sessionId} ("${session.title}") started by ${user.displayName}`);
        json(res, 201, { session });
        return true;
      }

      if (item && req.method === 'GET') {
        json(res, 200, { session: await service.get(decodeURIComponent(item[1]!), user.id) });
        return true;
      }

      if (item && req.method === 'DELETE') {
        await service.delete(decodeURIComponent(item[1]!), user.id);
        json(res, 200, { ok: true });
        return true;
      }

      if (action) {
        const sessionId = decodeURIComponent(action[1]!);
        const verb = action[2]!;

        if (verb === 'refine' && req.method === 'POST') {
          if (await throttled(res, rateLimiter, user)) return true;
          const body = await readJson(req);
          json(res, 200, { session: await service.refine(sessionId, user.id, String(body.brief ?? '')) });
          return true;
        }

        if (verb === 'draft' && req.method === 'PUT') {
          const body = await readJson(req);
          const rules = parseRules(body.rules);
          if (rules.error) {
            json(res, 400, { error: rules.error, reasons: rules.reasons });
            return true;
          }
          const strategy = typeof body.strategy === 'string' ? body.strategy : '';
          json(res, 200, { session: await service.applyManualEdit(sessionId, user.id, rules.value, strategy) });
          return true;
        }

        if (verb === 'revert' && req.method === 'POST') {
          const body = await readJson(req);
          const n = Number(body.n);
          if (!Number.isInteger(n) || n < 1) {
            json(res, 400, { error: 'Revision number must be a positive whole number' });
            return true;
          }
          json(res, 200, { session: await service.revert(sessionId, user.id, n) });
          return true;
        }

        if (verb === 'publish' && req.method === 'POST') {
          const result = await service.publish(sessionId, user.id);
          console.log(`[design] session ${sessionId} published as "${result.gameId}" by ${user.displayName}`);
          json(res, 200, { session: result.session, gameId: result.gameId });
          return true;
        }
      }

      json(res, 405, { error: 'Method not allowed' });
      return true;
    } catch (err) {
      respondToError(res, err);
      return true;
    }
  };
}

/**
 * Consumes one token of the caller's drafting budget. Returns true when the
 * request was refused — and has already been answered — so the call site reads
 * as a guard clause.
 */
async function throttled(res: ServerResponse, rateLimiter: RateLimiter, user: AuthUser): Promise<boolean> {
  const budget = await rateLimiter.consume(`design:${user.id}`, DESIGN_RULE);
  if (budget.allowed) return false;

  const seconds = Math.ceil(budget.retryAfterMs / 1000);
  res.setHeader('Retry-After', String(seconds));
  json(res, 429, {
    error: `You've made a lot of design requests in a row. Each one runs a full AI drafting pass — try again in about ${seconds} second${seconds === 1 ? '' : 's'}.`,
  });
  return true;
}

/**
 * Maps the service's error vocabulary onto status codes. Ordered most specific
 * first: `DesignNotPublishableError` and `PluginImportError` both describe a
 * draft the server refused, but only the second one can also mean "the plugin
 * layer said no" for a reason the designer never saw.
 */
function respondToError(res: ServerResponse, err: unknown): void {
  if (err instanceof DesignNotFoundError) {
    json(res, 404, { error: 'No such design session' });
  } else if (err instanceof DesignLimitError) {
    json(res, 400, { error: err.message });
  } else if (err instanceof DesignNotPublishableError) {
    json(res, 400, { error: 'This draft cannot be published yet', reasons: err.reasons });
  } else if (err instanceof PluginImportError) {
    json(res, 400, { error: 'The game catalog rejected this draft', reasons: err.reasons });
  } else if (err instanceof DesignError) {
    // The model failed or timed out. 502 rather than 500: the fault is in the
    // upstream provider, and the caller's own request was fine.
    json(res, 502, { error: err.message });
  } else if ((err as Error).message === 'Request body too large') {
    json(res, 413, { error: 'Request body too large' });
  } else {
    console.error('[design] request failed:', err);
    json(res, 500, { error: 'The design request failed unexpectedly' });
  }
}

/** `rules` may arrive as an object or as the raw text of a rules.json — the editor is a textarea. */
function parseRules(raw: unknown): { value?: unknown; error?: string; reasons?: string[] } {
  let rules = raw;
  if (typeof rules === 'string') {
    try {
      rules = JSON.parse(rules.charCodeAt(0) === 0xfeff ? rules.slice(1) : rules);
    } catch (err) {
      return { error: 'rules.json is not valid JSON', reasons: [(err as Error).message] };
    }
  }
  if (rules === undefined || rules === null) {
    return { error: 'Missing "rules"', reasons: ['Provide the contents of rules.json'] };
  }
  return { value: rules };
}

async function authenticate(req: IncomingMessage, authService: AuthService): Promise<AuthUser | null> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token ? authService.validateToken(token) : null;
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
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
