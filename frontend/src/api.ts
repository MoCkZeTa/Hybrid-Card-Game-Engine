/**
 * REST client for the auth endpoints. The session token is kept in
 * localStorage so a refresh doesn't log you out.
 */

import type { AuthSuccess, AuthUser, GameSummary } from '@hcg/shared';

const WS_URL = import.meta.env.VITE_WS_URL ?? 'ws://localhost:3001';
/** Derive the HTTP origin from the WS URL — they're the same server/port. */
export const API_BASE = WS_URL.replace(/^ws/, 'http');

const TOKEN_KEY = 'hcg.token';

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function storeToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
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
