/**
 * Origin checking for the WebSocket upgrade.
 *
 * This closes cross-site WebSocket hijacking. The browser same-origin policy
 * does **not** apply to WebSocket connections: any page on the internet can
 * open `ws://your-server` from a victim's browser. Our session token lives in
 * localStorage rather than a cookie, so an attacker's page cannot read it and
 * cannot authenticate — but an unauthenticated socket still costs a slot, a
 * heartbeat timer, and a rate-limit bucket. Rejecting at the upgrade is both
 * cheaper and one less thing depending on the token staying out of cookies.
 *
 * Non-browser clients (a CLI bot, `wscat`, load tests) send no `Origin` header
 * at all. Those are allowed: an attacker with a non-browser client has no
 * victim's credentials to ride on, which is the entire threat being defended
 * against here.
 */

const LOCALHOST = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+$/;

export interface OriginPolicy {
  /** Comma-separated allowlist, typically `CORS_ORIGIN`. */
  readonly allowed: readonly string[];
  /** Outside production, any localhost port is accepted so Vite's port hopping doesn't break dev. */
  readonly isProduction: boolean;
}

export function parseAllowedOrigins(raw: string | undefined): readonly string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

export function isOriginAllowed(origin: string | undefined, policy: OriginPolicy): boolean {
  // No Origin header — not a browser. See the note above.
  if (origin === undefined || origin === '') return true;

  const normalized = origin.replace(/\/$/, '');
  if (policy.allowed.includes(normalized)) return true;
  if (policy.allowed.includes('*')) return true;
  if (!policy.isProduction && LOCALHOST.test(normalized)) return true;
  return false;
}
