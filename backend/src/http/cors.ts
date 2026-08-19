/**
 * Vite falls back to 5174, 5175, ... whenever its default port is taken, so a
 * single fixed CORS_ORIGIN constantly goes stale in dev. Outside production,
 * reflect back any http://localhost:<port> origin instead of hard-coding one.
 */
import type { IncomingMessage } from 'node:http';

export function resolveCorsOrigin(
  req: IncomingMessage,
  allowedOrigin: string,
  isProduction: boolean,
): string {
  const requestOrigin = req.headers.origin;
  if (!isProduction && requestOrigin && /^https?:\/\/localhost:\d+$/.test(requestOrigin)) {
    return requestOrigin;
  }
  return allowedOrigin;
}
