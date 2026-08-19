/**
 * Domain errors shared by the match engine and the cluster routing layer.
 *
 * They live in their own module because both sides need them and importing
 * either from the other would be circular. They also cross the Redis bus: a
 * command executed on a remote node sends back the error's `name`, which
 * `match-gateway.ts` uses to rebuild the same class here — so a `SeatTaken`
 * raised two nodes away still reaches the client as `ERROR: SEAT_TAKEN`.
 *
 * Each therefore takes an optional explicit message, so the rebuilt copy can
 * carry the original wording rather than a re-derived approximation.
 */

export class SeatTakenError extends Error {
  constructor(seat: number, message?: string) {
    super(message ?? `Seat ${seat} is already claimed by another player`);
    this.name = 'SeatTakenError';
  }
}

export class NotHostError extends Error {
  constructor(message?: string) {
    super(message ?? 'Only the host who created this room can start the match');
    this.name = 'NotHostError';
  }
}

/** The match does not exist anywhere in the cluster, and nothing durable can be recovered. */
export class MatchNotFoundError extends Error {
  constructor(matchId: string, message?: string) {
    super(message ?? `No match "${matchId}" — it may have finished, or never existed`);
    this.name = 'MatchNotFoundError';
  }
}

/**
 * The match exists, but the node holding it is not answering. Unlike
 * `MatchNotFoundError` this is transient: the client should retry rather than
 * go back to the lobby.
 */
export class MatchUnavailableError extends Error {
  constructor(matchId: string, message?: string) {
    super(message ?? `The server holding match "${matchId}" is not responding — try again in a moment`);
    this.name = 'MatchUnavailableError';
  }
}

/** The caller exceeded a rate limit. `retryAfterMs` is how long to wait. */
export class RateLimitedError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`Too many requests — retry in ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = 'RateLimitedError';
  }
}
