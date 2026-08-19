/**
 * Authentication and plugin-catalog types shared by the backend and client.
 */

import type { TrumpMode } from './rules-schema.js';

export interface AuthUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
}

export interface AuthSuccess {
  readonly token: string;
  readonly user: AuthUser;
  /** Unix ms at which `token` stops being accepted. */
  readonly expiresAt: number;
}

export interface AuthFailure {
  readonly error: string;
}

export type AuthResponse = AuthSuccess | AuthFailure;

export function isAuthSuccess(res: AuthResponse): res is AuthSuccess {
  return (res as AuthSuccess).token !== undefined;
}

/**
 * Client-facing description of a loaded game plugin. Derived entirely from
 * the plugin's own `rules.json` — the frontend must never hardcode a game
 * list, or the PRD's "drop in a directory, zero code changes" promise would
 * only hold for the backend half of the stack.
 */
export interface GameSummary {
  readonly gameId: string;
  readonly displayName: string;
  /** Supported table sizes, ascending — a game may accept a range (Callbreak: 3-6). */
  readonly playerCounts: readonly number[];
  readonly defaultPlayerCount: number;
  readonly topology: 'solo' | 'fixed-pairs';
  /** Cards per player at each supported table size, keyed by count. */
  readonly handSizeByCount: Readonly<Record<string, number>>;
  readonly trumpMode: TrumpMode;
  readonly hasBidding: boolean;
  /**
   * Match lengths the room host may choose between, and what the control
   * starts on. Comes from the plugin via `handLimitBounds`, so a newly
   * imported game gets a correct round selector with no frontend change.
   */
  readonly handLimit: { readonly min: number; readonly max: number; readonly defaultValue: number };
  /** True when this plugin was imported at runtime rather than shipped with the server. */
  readonly imported: boolean;
}
