/**
 * REST client for the auth endpoints. The session token is kept in
 * localStorage so a refresh doesn't log you out.
 */

import type {
  AuthSuccess,
  AuthUser,
  DesignAvailability,
  DesignSessionDetail,
  DesignSessionSummary,
  GameSummary,
} from '@hcg/shared';

/**
 * Where the backend lives. Resolved once, here, and imported everywhere else —
 * `App.tsx` used to carry its own copy of this expression, which is exactly how
 * two of them drift apart.
 *
 * The production branch is the one that matters. `SERVE_STATIC=true` has the
 * backend serve this bundle itself, so the server is by definition whatever
 * origin the page came from — and hard-coding `localhost:3001` into a build
 * that gets deployed produces a client that connects to the *player's own
 * machine*. Nothing catches that: the build succeeds, the page loads, and the
 * socket fails in a browser we never see. Deriving it from `window.location`
 * cannot be wrong in the same way.
 *
 * `VITE_WS_URL` still wins when set, for a split-origin deploy where the client
 * really is served from somewhere else.
 */
function resolveWsUrl(): string {
  const configured = import.meta.env.VITE_WS_URL?.trim();
  if (configured) return configured;

  // Dev: Vite serves the page on :5173 while the backend listens on :3001, so
  // same-origin is the one thing it cannot be. Keeping this default means a
  // fresh clone runs with no frontend/.env at all.
  if (import.meta.env.DEV) return 'ws://localhost:3001';

  // A page served over https must use wss, or the browser blocks the socket as
  // mixed content.
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}`;
}

export const WS_URL = resolveWsUrl();
/** Derive the HTTP origin from the WS URL — they're the same server/port. */
export const API_BASE = WS_URL.replace(/^ws/, 'http');

/**
 * Session storage — deliberately two-tier. See `SESSION_PERSISTENCE.md` for the
 * full reasoning; the short version:
 *
 * `localStorage` alone made the session a **browser-wide singleton**. One slot,
 * one key, shared by every tab, restored silently on open. That produced two
 * failure modes: two accounts could not be signed in at once (the second login
 * overwrote the first, in a tab that kept happily playing as the first), and a
 * leftover token from days ago would silently sign you in as *whoever it
 * belonged to* — sessions live 7 days with sliding renewal, so stale tokens
 * stay valid a long time. No prompt, no indication, wrong identity.
 *
 * So the tab, not the browser, owns the session:
 *
 *   sessionStorage  authoritative, per-tab. Survives reload, dies with the tab.
 *   localStorage    opt-in persistence only ("Keep me signed in"), consulted
 *                   solely to seed a tab that has no session of its own.
 *
 * A tab that boots from the persisted slot immediately *adopts* the token into
 * its own `sessionStorage`, which is what makes the isolation hold: from that
 * moment the tab is pinned to that identity and another tab signing in as
 * somebody else cannot move it.
 */
const TOKEN_KEY = 'hcg.token';

/**
 * Web Storage throws rather than returning null in a few real situations —
 * Safari private browsing, "block all cookies", enterprise policy, and any
 * embedding context with storage partitioned off. A game that will happily run
 * signed-out should never white-screen because of it.
 */
function readKey(store: Storage): string | null {
  try {
    return store.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeKey(store: Storage, token: string | null): void {
  try {
    if (token === null) store.removeItem(TOKEN_KEY);
    else store.setItem(TOKEN_KEY, token);
  } catch {
    /* storage unavailable — the session simply does not outlive this page */
  }
}

export function getStoredToken(): string | null {
  const tabToken = readKey(sessionStorage);
  if (tabToken) return tabToken;

  // No session in this tab: fall back to the persisted slot, and adopt it so
  // every later read in this tab is tab-local. Without the adopt, two tabs both
  // seeded from `localStorage` would keep re-reading a slot that either of them
  // can overwrite, and the singleton problem comes straight back.
  const persisted = readKey(localStorage);
  if (persisted) writeKey(sessionStorage, persisted);
  return persisted;
}

/**
 * @param persist "Keep me signed in on this browser" — promotes the token to
 *   the shared slot so a future cold start can find it.
 *
 * When `persist` is false the shared slot is **cleared**, not left alone. That
 * slot holds exactly one token, so leaving a previous account's there after
 * signing in as someone else guarantees the next cold start restores the wrong
 * identity — precisely the bug this design exists to kill. The rule that falls
 * out is easy to state: the persisted slot always reflects the most recent
 * sign-in's intent, either filled by it or emptied by it.
 */
export function storeToken(token: string, persist: boolean): void {
  writeKey(sessionStorage, token);
  writeKey(localStorage, persist ? token : null);
}

export function clearToken(): void {
  writeKey(sessionStorage, null);
  writeKey(localStorage, null);
}

async function post(path: string, body: unknown, token?: string): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(json.error ?? `Request failed (${res.status})`));
  return json;
}

export async function register(email: string, password: string, displayName: string): Promise<AuthSuccess> {
  return (await post('/api/auth/register', { email, password, displayName })) as AuthSuccess;
}

export async function login(email: string, password: string): Promise<AuthSuccess> {
  return (await post('/api/auth/login', { email, password })) as AuthSuccess;
}

export async function logout(token: string): Promise<void> {
  await post('/api/auth/logout', {}, token).catch(() => undefined);
}

export interface PluginImportResult {
  readonly game: GameSummary;
}

/**
 * The target is a built-in game (HTTP 403) — 29 and Callbreak ship with the
 * server and no user may edit or delete them. Thrown instead of a plain `Error`
 * so the UI can offer the useful alternative (import a copy) rather than just
 * relaying a refusal.
 */
export class PluginProtectedError extends Error {
  constructor(readonly gameId: string) {
    super(`"${gameId}" is a built-in game and cannot be modified or deleted`);
    this.name = 'PluginProtectedError';
  }
}

interface PluginWriteResponse {
  game?: GameSummary;
  error?: string;
  reasons?: string[];
  code?: string;
  gameId?: string;
}

async function pluginWriteResult(res: Response, verb: string): Promise<GameSummary> {
  const json = (await res.json().catch(() => ({}))) as PluginWriteResponse;
  if (!res.ok) {
    if (res.status === 403 && json.code === 'GAME_PROTECTED') {
      throw new PluginProtectedError(json.gameId ?? '');
    }
    const detail = json.reasons?.length ? `${json.error}:\n• ${json.reasons.join('\n• ')}` : json.error;
    throw new Error(detail ?? `${verb} failed (${res.status})`);
  }
  return json.game!;
}

/**
 * Uploads a rules.json + strategy.md pair as a **new** game. The server assigns
 * its id — `rules.json` carries none — so importing the same file twice gives
 * you two independent games rather than a conflict. Use `updatePlugin` to
 * change one you already own. Server-side validation errors come back as
 * `reasons`.
 */
export async function importPlugin(token: string, rules: string, strategy: string): Promise<GameSummary> {
  const res = await fetch(`${API_BASE}/api/plugins`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ rules, strategy }),
  });
  return pluginWriteResult(res, 'Import');
}

/**
 * Replaces the content of a plugin you own, keeping its id so rooms and match
 * records that reference it stay valid. Rejects with `PluginProtectedError`
 * for a built-in game.
 */
export async function updatePlugin(
  token: string,
  gameId: string,
  rules: string,
  strategy: string,
): Promise<GameSummary> {
  const res = await fetch(`${API_BASE}/api/plugins/${encodeURIComponent(gameId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ rules, strategy }),
  });
  return pluginWriteResult(res, 'Save');
}

export interface PluginSource {
  readonly gameId: string;
  readonly rules: unknown;
  readonly strategy: string;
  readonly imported: boolean;
  /** True for a shipped game: viewable and forkable, but not editable or deletable. */
  readonly builtIn: boolean;
}

/** Fetches a plugin's raw rules.json + strategy.md, for the edit form. */
export async function fetchPluginSource(token: string, gameId: string): Promise<PluginSource> {
  const res = await fetch(`${API_BASE}/api/plugins/${encodeURIComponent(gameId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = (await res.json().catch(() => ({}))) as PluginSource & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `Failed to load plugin source (${res.status})`);
  return json;
}

/** Deletes a plugin you own. Rejects with `PluginProtectedError` for a built-in game. */
export async function deletePlugin(token: string, gameId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/plugins/${encodeURIComponent(gameId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as PluginWriteResponse;
    if (res.status === 403 && json.code === 'GAME_PROTECTED') {
      throw new PluginProtectedError(json.gameId ?? gameId);
    }
    throw new Error(json.error ?? `Delete failed (${res.status})`);
  }
}

export async function fetchMe(token: string): Promise<AuthUser | null> {
  const res = await fetch(`${API_BASE}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return (await res.json()) as AuthUser;
}

// ---- Password reset and account management ---------------------------------
// These back endpoints that already existed in `auth-routes.ts` but had no
// caller: the reset link the server emails had no page to land on, and
// change-password / sessions / logout-all were reachable only with curl.

/**
 * Starts a password reset. Resolves the same way for a registered address and
 * an unknown one — the server answers `{ok:true}` either way so the endpoint
 * cannot be used to test which emails have accounts. **The UI must not
 * distinguish them either**, or it hands back exactly what the server refuses
 * to leak.
 */
export async function forgotPassword(email: string): Promise<void> {
  await post('/api/auth/forgot-password', { email });
}

/**
 * Completes a reset with the token from the emailed link and signs the user in.
 * Every pre-existing session for the account is revoked server-side: a reset is
 * what you do when you have lost control of the account, so the sessions
 * already out there are the ones you are trying to kill.
 */
export async function resetPassword(token: string, password: string): Promise<AuthSuccess> {
  return (await post('/api/auth/reset-password', { token, password })) as AuthSuccess;
}

/** Changes the password of the signed-in account. Also revokes other sessions. */
export async function changePassword(token: string, currentPassword: string, newPassword: string): Promise<void> {
  await post('/api/auth/change-password', { currentPassword, newPassword }, token);
}

/** How many sessions this account currently has, including the caller's own. */
export async function fetchSessionCount(token: string): Promise<number> {
  const res = await fetch(`${API_BASE}/api/auth/sessions`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = (await res.json().catch(() => ({}))) as { count?: number; error?: string };
  if (!res.ok) throw new Error(json.error ?? `Failed to load sessions (${res.status})`);
  return json.count ?? 0;
}

/**
 * Signs out everywhere. `keepCurrent` decides whether this browser survives —
 * true is "kick my other devices off", false is "kick everything off including
 * me", which is what you want if you think the account is compromised.
 */
export async function logoutEverywhere(token: string, keepCurrent: boolean): Promise<void> {
  await post('/api/auth/logout-all', { keepCurrent }, token);
}

// ---- AI game designer -------------------------------------------------------
// Describe a game in plain language, get a rules.json + strategy.md draft back,
// then refine it over a few turns before publishing it into your catalog.
// Publishing goes through the same plugin write path an uploaded file takes —
// see `backend/src/http/design-routes.ts`.

/** Shared request helper for the design endpoints, which all speak the same error shape. */
async function designRequest<T>(
  path: string,
  init: { method: string; token: string; body?: unknown },
): Promise<T> {
  const res = await fetch(`${API_BASE}/api/design${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${init.token}`,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

  const json = (await res.json().catch(() => ({}))) as {
    error?: string;
    reasons?: string[];
  } & Record<string, unknown>;

  if (!res.ok) {
    // `reasons` carries the per-field validation detail. Flattening it into the
    // message here means every caller shows the useful half without having to
    // know the endpoint returns two fields.
    const detail = json.reasons?.length ? `${json.error}:\n• ${json.reasons.join('\n• ')}` : json.error;
    throw new Error(detail ?? `Request failed (${res.status})`);
  }
  return json as T;
}

/**
 * Whether this server has an LLM configured for drafting. Called before the
 * feature is rendered: the designer is the one part of the app with no degraded
 * mode, so a deployment without a key hides it rather than offering a button
 * that always fails.
 */
export async function fetchDesignAvailability(): Promise<DesignAvailability> {
  const res = await fetch(`${API_BASE}/api/design`);
  if (!res.ok) return { available: false, reason: `The server did not answer (${res.status})` };
  return (await res.json()) as DesignAvailability;
}

export async function listDesignSessions(token: string): Promise<DesignSessionSummary[]> {
  const { sessions } = await designRequest<{ sessions: DesignSessionSummary[] }>('/sessions', {
    method: 'GET',
    token,
  });
  return sessions;
}

export async function fetchDesignSession(token: string, sessionId: string): Promise<DesignSessionDetail> {
  const { session } = await designRequest<{ session: DesignSessionDetail }>(
    `/sessions/${encodeURIComponent(sessionId)}`,
    { method: 'GET', token },
  );
  return session;
}

/** Starts a session and drafts revision 1 from a plain-language description. */
export async function startDesignSession(token: string, brief: string): Promise<DesignSessionDetail> {
  const { session } = await designRequest<{ session: DesignSessionDetail }>('/sessions', {
    method: 'POST',
    token,
    body: { brief },
  });
  return session;
}

/** One more turn: "make it three players", "add a nil bid". Appends a revision. */
export async function refineDesign(token: string, sessionId: string, brief: string): Promise<DesignSessionDetail> {
  const { session } = await designRequest<{ session: DesignSessionDetail }>(
    `/sessions/${encodeURIComponent(sessionId)}/refine`,
    { method: 'POST', token, body: { brief } },
  );
  return session;
}

/** Saves a draft the author edited by hand. Validated exactly as a generated one is. */
export async function saveDesignDraft(
  token: string,
  sessionId: string,
  rules: string,
  strategy: string,
): Promise<DesignSessionDetail> {
  const { session } = await designRequest<{ session: DesignSessionDetail }>(
    `/sessions/${encodeURIComponent(sessionId)}/draft`,
    { method: 'PUT', token, body: { rules, strategy } },
  );
  return session;
}

/** Brings an earlier revision back as the current one, by appending it. */
export async function revertDesign(token: string, sessionId: string, n: number): Promise<DesignSessionDetail> {
  const { session } = await designRequest<{ session: DesignSessionDetail }>(
    `/sessions/${encodeURIComponent(sessionId)}/revert`,
    { method: 'POST', token, body: { n } },
  );
  return session;
}

/**
 * Puts the current draft in your game catalog. The first publish creates a
 * game; later ones update that same game, so iterating does not litter the
 * lobby with near-identical entries.
 */
export async function publishDesign(
  token: string,
  sessionId: string,
): Promise<{ session: DesignSessionDetail; gameId: string }> {
  return designRequest<{ session: DesignSessionDetail; gameId: string }>(
    `/sessions/${encodeURIComponent(sessionId)}/publish`,
    { method: 'POST', token },
  );
}

/** Deletes the session. A game already published from it is left alone. */
export async function deleteDesignSession(token: string, sessionId: string): Promise<void> {
  await designRequest(`/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE', token });
}
