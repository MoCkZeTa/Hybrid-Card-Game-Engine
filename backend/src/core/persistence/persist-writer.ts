/**
 * The off-critical-path persistence hook. `schedule()` is called from the
 * turn loop right after a move is applied in memory — it returns
 * immediately; the actual durable write happens on its own time and its
 * failure never propagates back into game flow. If it fails, the next
 * successful write self-heals the record (each write carries the full
 * current state, not a delta).
 */

import type { GameState } from '@hcg/shared';
import type { MatchRepository } from './match-repository.js';

export class AsyncPersistenceWriter {
  constructor(
    private readonly repository: MatchRepository,
    private readonly onError: (err: unknown, matchId: string, sequence: number) => void = (err, matchId, sequence) =>
      console.error(`[persistence] failed to save match "${matchId}" @ seq ${sequence}:`, err),
  ) {}

  schedule(matchId: string, gameId: string, sequence: number, state: GameState): void {
    void this.repository.save(matchId, gameId, sequence, state).catch((err) => this.onError(err, matchId, sequence));
  }
}
