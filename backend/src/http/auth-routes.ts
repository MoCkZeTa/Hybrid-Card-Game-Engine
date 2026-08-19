/**
 * Minimal HTTP surface for auth, built on `node:http` — the WebSocket server
 * already needs an http server to attach to, so reusing it avoids pulling in
 * Express for three endpoints.
 *
 *   POST /api/auth/register  { email, password, displayName } -> AuthSuccess
 *   POST /api/auth/login     { email, password }              -> AuthSuccess
 *   POST /api/auth/logout    (Bearer token)                   -> { ok: true }
 *   GET  /api/auth/me        (Bearer token)                   -> AuthUser
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { AuthError, type AuthService } from '../core/auth/auth-service.js';
import { resolveCorsOrigin } from './cors.js';
import { AUTH_RULE, type RateLimiter } from '../core/ratelimit/rate-limiter.js';
import { clientIp } from '../ws/ws-server.js';

const MAX_BODY_BYTES = 8 * 1024;

export function createAuthHandler(
  authService: AuthService,
  allowedOrigin: string,
  isProduction: boolean,
  /** Throttles register/login per IP. Password guessing is the whole reason this exists. */
  rateLimiter: RateLimiter,
) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = req.url ?? '';
    if (!url.startsWith('/api/')) return false;

    applyCors(res, resolveCorsOrigin(req, allowedOrigin, isProduction));
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return true;
    }

    // Only the credential-checking endpoints are throttled. `/me` and `/logout`
    // present a token the caller already holds, so rate limiting them would
    // only punish a client reconnecting after a network blip.
    if ((url === '/api/auth/login' || url === '/api/auth/register') && req.method === 'POST') {
      const budget = await rateLimiter.consume(`auth:${clientIp(req)}`, AUTH_RULE);
      if (!budget.allowed) {
        res.setHeader('Retry-After', String(Math.ceil(budget.retryAfterMs / 1000)));
        json(res, 429, { error: 'Too many attempts — please wait a moment and try again' });
        return true;
      }
    }

    try {
      if (url === '/api/auth/register' && req.method === 'POST') {
        const body = await readJson(req);
        const result = await authService.register(
          String(body.email ?? ''),
          String(body.password ?? ''),
          String(body.displayName ?? ''),
        );
        json(res, 200, result);
        return true;
      }

      if (url === '/api/auth/login' && req.method === 'POST') {
        const body = await readJson(req);
        const result = await authService.login(String(body.email ?? ''), String(body.password ?? ''));
        json(res, 200, result);
        return true;
      }

      if (url === '/api/auth/logout' && req.method === 'POST') {
        const token = bearerToken(req);
        if (token) await authService.logout(token);
        json(res, 200, { ok: true });
        return true;
      }

      if (url === '/api/auth/me' && req.method === 'GET') {
        const token = bearerToken(req);
        const user = token ? await authService.validateToken(token) : null;
        if (!user) {
          json(res, 401, { error: 'Not authenticated' });
          return true;
        }
        json(res, 200, user);
        return true;
      }

      json(res, 404, { error: 'Not found' });
      return true;
    } catch (err) {
      if (err instanceof AuthError) {
        json(res, err.status, { error: err.message });
      } else {
        console.error('[auth] unhandled error:', err);
        json(res, 500, { error: 'Internal server error' });
      }
      return true;
    }
  };
}

function applyCors(res: ServerResponse, allowedOrigin: string): void {
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
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
    if (size > MAX_BODY_BYTES) throw new AuthError('Request body too large', 413);
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>;
  } catch {
    throw new AuthError('Request body was not valid JSON', 400);
  }
}
