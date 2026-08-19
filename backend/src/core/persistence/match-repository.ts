/**
 * Persistence abstraction for live match state.
 *
 * Per the product decision to persist in-progress games (not just completed
 * ones), every applied move is written durably enough to survive a server
 * restart or a dropped client connection. But PRD 6 budgets the *entire* turn
 * at 1500ms including a 1200ms LLM call — a synchronous Atlas round-trip
 * (typically 50-200ms) cannot be paid for out of what's left. So writes are
 * fire-and-forget from the turn loop's perspective (see `AsyncPersistenceWriter`
 * in `persist-writer.ts`): the turn resolves from in-memory state immediately,
 * and the durable write lands a moment later, tagged with a monotonic
 * `sequence` number so a resume can detect and replay from the last
 * successfully durable move.
 *
 * `MatchRepository` is an interface specifically so tests (and local dev
 * without Mongo configured) can run against `InMemoryMatchRepository` instead
 * of a live Atlas cluster.
 */

import type { GameState } from '@hcg/shared';

export interface PersistedMatch {
  readonly matchId: string;
  readonly gameId: string;
  readonly sequence: number;
  readonly state: GameState;
  readonly updatedAt: Date;
}

export interface MatchRepository {
  save(matchId: string, gameId: string, sequence: number, state: GameState): Promise<void>;
  load(matchId: string): Promise<PersistedMatch | null>;
  delete(matchId: string): Promise<void>;
}

export class InMemoryMatchRepository implements MatchRepository {
  private readonly store = new Map<string, PersistedMatch>();

  async save(matchId: string, gameId: string, sequence: number, state: GameState): Promise<void> {
    const existing = this.store.get(matchId);
    if (existing && existing.sequence > sequence) return; // never let a stale write clobber a newer one
    this.store.set(matchId, { matchId, gameId, sequence, state, updatedAt: new Date() });
  }

  async load(matchId: string): Promise<PersistedMatch | null> {
    return this.store.get(matchId) ?? null;
  }

  async delete(matchId: string): Promise<void> {
    this.store.delete(matchId);
  }
}
