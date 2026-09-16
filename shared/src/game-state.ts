/**
 * Runtime game state shapes.
 *
 * Two parallel types matter here:
 *  - `GameState`      — the full, authoritative truth. Only the backend ever
 *                        holds this.
 *  - `MaskedGameState` — the fog-of-war projection of `GameState` for one
 *                        specific viewer (a player seat, or the AI deciding on
 *                        that seat's behalf). This is the only shape that ever
 *                        leaves the process boundary — over the wire to the
 *                        client, or into an LLM prompt.
 */

import type { CardId, MaskedCard, Suit, HiddenStatus } from './cards.js';
import type { LegalMove } from './moves.js';

export type SeatIndex = number;

// ---------------------------------------------------------------------------
// Round / game results
// ---------------------------------------------------------------------------

/**
 * Whether a result describes one hand (`ROUND`) or the whole match (`GAME`).
 * A `GAME` result is emitted in place of the final hand's `ROUND` result — the
 * last hand's numbers are still in `rows`, so nothing is lost by not sending
 * both.
 */
export type ResultScope = 'ROUND' | 'GAME';

export type ContractOutcome = 'MADE' | 'MISSED';

export type GameEndReason = 'target-score' | 'hand-limit';

/**
 * One competitor's line in a result table. "Competitor" is deliberately
 * game-agnostic: it is a team in a `fixed-pairs` game and a single seat in a
 * `solo` one, matching whatever `teamScores` is keyed by. Every field is
 * derived from the rules DSL, so a newly imported plugin gets a correct
 * result table with no client changes.
 */
export interface ResultRow {
  /** The `teamScores` key — `"team-0"` or `"seat-2"`. */
  readonly key: string;
  /** Display label: the team's name in a pairs game, the player's name in a solo one. */
  readonly label: string;
  readonly seats: readonly SeatIndex[];
  readonly playerNames: readonly string[];
  /** Combined bid for this competitor, or null if the game has no bidding (or nobody bid). */
  readonly bid: number | null;
  /** What they actually captured this hand — tricks or card points, per `scoring.contractBasis`. */
  readonly made: number;
  /** Change to the running score from this hand. Diffed from the real scores, so it always matches what the engine did. */
  readonly delta: number;
  /** Running match score after this hand. */
  readonly total: number;
  readonly isDeclarer: boolean;
  /** Whether they met their contract, or null when the game defines none. */
  readonly contract: ContractOutcome | null;
  /** 1-based standing by `total`, ties sharing a rank. */
  readonly rank: number;
}

export interface ResultSummary {
  readonly scope: ResultScope;
  /** Which hand this result covers (1-based). */
  readonly handNumber: number;
  /** Total hands this match will play, or null if it ends on a target score instead. */
  readonly totalHands: number | null;
  /** What `made` counts — carried through so the client can label the column without knowing the game. */
  readonly basis: 'tricks' | 'points' | 'none';
  /** Every competitor, already sorted best-first by `total`. */
  readonly rows: readonly ResultRow[];
  /** Keys with the best score *this hand* — who won the round. */
  readonly roundWinnerKeys: readonly string[];
  /** Keys leading on running total — the overall winner once `scope` is `GAME`. */
  readonly winnerKeys: readonly string[];
  /** Why the match ended. Null while `scope` is `ROUND`. */
  readonly endReason: GameEndReason | null;
}

export interface PlayerState {
  readonly seat: SeatIndex;
  readonly name: string;
  readonly isAI: boolean;
  readonly hand: readonly CardId[];
  readonly tricksWon: number;
  readonly bid: number | null;
  /**
   * Position of this seat's *first* bid in the hand's bidding sequence (0-based,
   * monotonic across seats), or null if the seat has never bid. This is bid
   * seniority: in 29, "a player can match a previous bid if they placed it
   * first", so the seat that opened earlier may hold a challenger's number
   * instead of having to go one higher (`bidding.holdBidBySeniority`).
   * Seniority is set once, at a seat's opening bid, and never changes when that
   * seat later raises.
   */
  readonly bidOrder: number | null;
}

export interface TrickCard {
  readonly seat: SeatIndex;
  readonly card: CardId;
}

/**
 * A trick that has finished, retained for the rest of the hand.
 *
 * This is the raw fact that `PlayerState.tricksWon` and `GameState.handPoints`
 * are summaries of. Without it those summaries are the only surviving record,
 * so a decision-maker can see *how many* tricks a seat won but never *which
 * cards* have already left the deck — which is exactly what card counting
 * needs, and what both shipped `strategy.md` files ask the AI to do.
 *
 * Carries no hidden information: every card in it was played face up in front
 * of the whole table, so it crosses the fog-of-war boundary unmasked.
 */
export interface CompletedTrick {
  readonly cards: readonly TrickCard[];
  readonly winnerSeat: SeatIndex;
  readonly leadSuit: Suit;
}

export interface GameState {
  readonly gameId: string;
  readonly matchId: string;
  readonly phase: string;
  readonly dealerSeat: SeatIndex;
  readonly turnSeat: SeatIndex;
  readonly declarerSeat: SeatIndex | null;
  readonly trumpSuit: Suit | null;
  readonly trumpRevealed: boolean;
  /**
   * True for the window between a seat firing a non-atomic REVEAL_TRUMP
   * action (`CompoundActionRule.atomic: false`) and that same seat's next
   * PLAY_CARD — i.e. "this seat still owes the trick-play its reveal was
   * for". Cleared unconditionally on every PLAY_CARD, so it can never leak
   * into a later trick or a different seat's turn. Purely engine bookkeeping;
   * not sent to clients or the AI prompt.
   */
  readonly pendingTrumpReveal: boolean;
  readonly players: readonly PlayerState[];
  readonly currentTrick: readonly TrickCard[];
  /** The most recently completed trick (all seats' cards), kept around purely so a client can display it briefly after `currentTrick` clears back to empty. Null until the first trick resolves. */
  readonly lastTrick: readonly TrickCard[] | null;
  /**
   * Every trick finished this hand, oldest first; reset on every deal.
   * `lastTrick` is this array's final entry, kept as its own field because the
   * client's trick animation reads it on every state push and shouldn't have
   * to index into a growing array to find it.
   */
  readonly completedTricks: readonly CompletedTrick[];
  readonly leadSuit: Suit | null;
  readonly kitty: readonly CardId[];
  /** Persistent match score per team key, carried across hands. */
  readonly teamScores: Readonly<Record<string, number>>;
  /**
   * Undischarged overtricks per team key (`scoring.bags`). The only scoring
   * quantity that survives a hand without being folded into `teamScores` —
   * Spades pays these off in lumps of ten, so the running remainder has to be
   * carried rather than recomputed from the hand just played.
   */
  readonly bags: Readonly<Record<string, number>>;
  /**
   * Suits in `trickRules.lockedLeadSuits` that have been played this hand and
   * so may now be led ("hearts are broken"). Reset every deal. Engine
   * bookkeeping — the constraint it produces is already visible to players
   * through `legalMoves`.
   */
  readonly brokenSuits: readonly Suit[];
  /** Points captured *this hand only* (contractBasis: 'points' games) — reset to 0 at the start of every hand, folded into teamScores by applyHandScoring. */
  readonly handPoints: Readonly<Record<string, number>>;
  readonly handNumber: number;
  /**
   * Match length chosen by the host when the room was created, or null to use
   * whatever the plugin declares. Stored rather than resolved so the
   * "how many hands does this show as" question can still tell an explicit
   * choice apart from a plugin default.
   */
  readonly maxHandsOverride: number | null;
  /** Present only while a MicroPhaseRule is active; null otherwise. */
  readonly activeMicroPhase: { readonly id: string; readonly stepIndex: number } | null;
  /**
   * The result of the hand that just finished, set when scoring is applied and
   * cleared when the next hand is dealt. A `GAME`-scoped result is terminal:
   * no further hand follows it.
   */
  readonly lastResult: ResultSummary | null;
}

// ---------------------------------------------------------------------------
// Masked (fog-of-war) projection
// ---------------------------------------------------------------------------

export interface MaskedPlayerState {
  readonly seat: SeatIndex;
  readonly name: string;
  readonly isAI: boolean;
  /** The viewer's own cards are real; every other seat's hand is a same-length array of "HIDDEN". */
  readonly hand: readonly MaskedCard[];
  readonly handCount: number;
  readonly tricksWon: number;
  readonly bid: number | null;
  /** This seat's `teamScores`/`handPoints` key in a `fixed-pairs` game, or null in a `solo` one. */
  readonly teamKey: string | null;
}

export interface MaskedGameState {
  readonly gameId: string;
  readonly matchId: string;
  readonly phase: string;
  readonly dealerSeat: SeatIndex;
  readonly turnSeat: SeatIndex;
  readonly declarerSeat: SeatIndex | null;
  /** `"STATUS: HIDDEN"` until trumpRevealed is true, or until the viewer is the declarer. */
  readonly trumpSuit: Suit | HiddenStatus | null;
  readonly trumpRevealed: boolean;
  readonly players: readonly MaskedPlayerState[];
  readonly currentTrick: readonly TrickCard[];
  readonly lastTrick: readonly TrickCard[] | null;
  /**
   * The hand's completed tricks in full, oldest first. Passed through the mask
   * unaltered — these cards were all played face up, so withholding them would
   * hide public information rather than protect private information.
   *
   * A *bot* may be shown less than this: `compilePrompt` trims the history by
   * the bot's difficulty level. That trimming is a capability limit on one AI
   * seat, not an entitlement limit on the viewer, so it belongs downstream of
   * the mask — never here, where it would also blind the human client.
   */
  readonly completedTricks: readonly CompletedTrick[];
  readonly leadSuit: Suit | null;
  /** Kitty contents are never visible to anyone once dealt, unless the game reveals them at scoring. */
  readonly kittyCount: number;
  readonly teamScores: Readonly<Record<string, number>>;
  /**
   * Card points captured *this hand only*, keyed the same as `teamScores` —
   * live progress toward the current contract in a `contractBasis: 'points'`
   * game (29). Always present (zeros) for a `'tricks'`/`'none'` game; not
   * hidden information, since every point value is visible the moment its
   * trick is won.
   */
  readonly handPoints: Readonly<Record<string, number>>;
  /**
   * Undischarged overtricks per competitor, for a game that accumulates them
   * (`scoring.bags`). Public information — every overtrick was visible as it
   * was won. All zeros for a game with no bag rule.
   */
  readonly bags: Readonly<Record<string, number>>;
  /** What `made`/`handPoints`/`teamScores` actually count — lets a client render live progress without knowing the game. */
  readonly scoringBasis: 'tricks' | 'points' | 'none';
  /** True when the lowest total wins (Hearts), so a client can order its scoreboard without knowing the game. */
  readonly lowerScoreWins: boolean;
  readonly handNumber: number;
  /** How many hands this match runs in total, or null when it ends on a target score instead of a fixed length. */
  readonly totalHands: number | null;
  readonly activeMicroPhase: { readonly id: string; readonly stepIndex: number } | null;
  /** The viewer this projection was built for. */
  readonly viewerSeat: SeatIndex | 'SPECTATOR';
  /** Bounded choices available to `viewerSeat`, empty if it is not their turn. */
  readonly legalMoves: readonly LegalMove[];
  /** Result of the hand that just finished — the client's cue to show the round/game popup. Null mid-hand. */
  readonly lastResult: ResultSummary | null;
  /**
   * Whether `viewerSeat`'s own competitor is among the winners of
   * `lastResult` (the round winners for a `ROUND` result, the overall winners
   * for a `GAME` one). Null for spectators and mid-hand.
   */
  readonly viewerWon: boolean | null;
  /** True once the match is finished and no further hand will be dealt. */
  readonly matchOver: boolean;
  /**
   * Milliseconds until the next hand is dealt, measured from when this state
   * was sent. The client counts down from receipt rather than comparing
   * timestamps, so no clock-skew correction is needed. Null unless a round
   * intermission is running.
   */
  readonly nextRoundInMs: number | null;
}
