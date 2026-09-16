/**
 * Serves the built frontend from the same process as the API and the game
 * socket, when `SERVE_STATIC=true`.
 *
 * This is optional on purpose. A CDN or an nginx container in front is the
 * better production answer, and `docker-compose.prod.yml` wires it that way.
 * But single-container hosts (Railway, Render, Fly, a VPS) are how a project
 * this size actually gets deployed, and on those, "one process serves
 * everything on one port" removes an entire class of problem: no separate
 * frontend deploy, no CORS configuration, no second origin to add to the
 * WebSocket allowlist, and the socket connects back to the exact origin that
 * served the page.
 *
 * Two details that matter more than they look:
 *
 *  - **SPA fallback.** The client routes `/reset-password?token=…` in the
 *    browser. A password-reset link opens that URL *cold*, so the server has to
 *    answer a path that is not a file with `index.html` or the link is dead.
 *  - **Two cache policies.** Vite fingerprints everything under `/assets`, so
 *    those are immutable for a year. `index.html` names them and must never be
 *    cached, or a returning browser pairs a fresh page with a deleted bundle.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

export interface StaticFileOptions {
  /** Absolute path to the built frontend (`frontend/dist`). */
  readonly root: string;
}

export function createStaticHandler(options: StaticFileOptions) {
  const root = path.resolve(options.root);

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;

    const requestPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    // Never serve the API or the health probes from disk, whatever happens to
    // be sitting in the build directory.
    if (requestPath.startsWith('/api/') || requestPath === '/health' || requestPath === '/ready') return false;

    const resolved = resolveWithinRoot(root, requestPath);
    if (resolved) {
      const info = await stat(resolved).catch(() => null);
      if (info?.isFile()) {
        sendFile(req, res, resolved, cacheHeaderFor(requestPath));
        return true;
      }
    }

    // Anything else is a client-side route. Hand back the shell and let the
    // router work out what it means — this is what keeps a reset link alive.
    const indexPath = path.join(root, 'index.html');
    const index = await stat(indexPath).catch(() => null);
    if (!index?.isFile()) return false;

    sendFile(req, res, indexPath, 'no-cache');
    return true;
  };
}

/**
 * Resolves a URL path inside `root`, or null if it escapes.
 *
 * `..` segments survive URL decoding, so `/%2e%2e/%2e%2e/.env` is a real
 * request an attacker will make. Comparing the *resolved* path against the root
 * is the check that holds, rather than trying to spot bad input.
 */
function resolveWithinRoot(root: string, requestPath: string): string | null {
  if (requestPath.includes('\0')) return null;
  const candidate = path.resolve(root, '.' + path.posix.normalize(requestPath));
  if (candidate !== root && !candidate.startsWith(root + path.sep)) return null;
  return candidate;
}

function cacheHeaderFor(requestPath: string): string {
  // Vite writes content-hashed filenames into /assets; those can never change
  // meaning, so they are safe to keep forever.
  if (requestPath.startsWith('/assets/')) return 'public, max-age=31536000, immutable';
  // index.html is the one file that must always be revalidated: it is what
  // names the current bundle.
  if (requestPath === '/' || requestPath.endsWith('.html')) return 'no-cache';
  return 'public, max-age=3600';
}

function sendFile(req: IncomingMessage, res: ServerResponse, filePath: string, cacheControl: string): void {
  const type = CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': cacheControl,
    // The app is same-origin only; nothing here should ever be framed.
    'X-Content-Type-Options': 'nosniff',
    // Mitigate XSS attacks by restricting where resources can be loaded from.
    // Critical because session tokens live in localStorage, making XSS highly dangerous.
    'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; object-src 'none'; base-uri 'self';",
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const stream = createReadStream(filePath);
  stream.on('error', () => {
    // The file existed a moment ago (we stat'd it) — a mid-deploy swap is the
    // realistic cause. Headers are already out, so all we can do is stop.
    res.destroy();
  });
  stream.pipe(res);
}
