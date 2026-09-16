/**
 * Applies a chosen `LegalMove` to a `GameState`, producing the next state.
 *
 * This is the only place authoritative state changes happen. It never
 * consults the AI — by the time a `moveId` reaches here, a decision (human,
 * LLM, or timeout-fallback per PRD 6) has already resolved to one specific
 * option from `generateLegalMoves`'s output, and this function's only job is
 * to re-validate that and apply it atomically (PRD 4.2 Requirement A: a
 * multi-action move's actions are applied in sequence with no other move
 * interleaved).
 */

import type { EngineAction, GameState, LegalMove, PlayerState, RulesDsl, SeatIndex, TrickCard } from '@hcg/shared';
import { parseCard } from '@hcg/shared';
import { generateLegalMoves } from './legal-moves.js';
import { highBidHolder, nextBidOrder, nextPhase, teamKeyForSeat } from './state.js';
import { resolveTrick, trickPointValue } from './trick.js';

export class IllegalMoveError extends Error {
  constructor(moveId: string) {
    super(`"${moveId}" is not a legal move in the current state`);
    this.name = 'IllegalMoveError';
  }
}

/** Table size is read from the live state, so a variable-size plugin needs no special casing. */
function seatAfter(state: GameState, seat: SeatIndex): SeatIndex {
  return (seat + 1) % state.players.length;
}

function leftOfDealer(state: GameState): SeatIndex {
  return seatAfter(state, state.dealerSeat);
}

function updatePlayer(state: GameState, seat: SeatIndex, patch: Partial<PlayerState>): GameState {
  const players = state.players.map((p) => (p.seat === seat ? { ...p, ...patch } : p));
  return { ...state, players };
}

/**
 * Applies `moveId` — re-validating it against `generateLegalMoves` first, so
 * a malformed or stale client/AI message can never mutate state (PRD 5.2,
 * "Invalid Choice Handling": an out-of-set identifier MUST be rejected).
 */
export function applyMove(rules: RulesDsl, state: GameState, moveId: string): GameState {
  const legal = generateLegalMoves(rules, state);
  const move = legal.find((m) => m.id === moveId);
  if (!move) throw new IllegalMoveError(moveId);
  return applyLegalMove(rules, state, move);
}

/** Same as `applyMove` but skips re-lookup — used when the caller already holds the validated `LegalMove`. */
export function applyLegalMove(rules: RulesDsl, state: GameState, move: LegalMove): GameState {
  return move.actions.reduce((s, action) => applyAction(rules, s, action), state);
}

function applyAction(rules: RulesDsl, state: GameState, action: EngineAction): GameState {
  switch (action.type) {
    case 'PLACE_BID': {
      // Seniority is stamped once, on a seat's opening bid, and survives every
      // later raise — see `PlayerState.bidOrder` and `nextBidOrder`.
      const seat = state.turnSeat;
      const existing = state.players[seat]!.bidOrder;
      return advanceBidding(
        rules,
        updatePlayer(state, seat, {
          bid: action.value,
          bidOrder: existing ?? nextBidOrder(state),
        }),
      );
    }
    case 'PASS_BID':
      return advanceBidding(rules, updatePlayer(state, state.turnSeat, { bid: -1 }));
    case 'SELECT_TRUMP':
      return advanceAfterTrumpSelection(rules, {
        ...state,
        trumpSuit: action.suit,
        trumpRevealed: !action.concealed,
      });
    case 'REVEAL_TRUMP':
      // For an atomic compound move the very next action in the same
      // `applyLegalMove` reduce is the paired PLAY_CARD, which clears this
      // again before anything ever observes it. For a non-atomic reveal it
      // persists until that PLAY_CARD arrives as a separate turn.
      return { ...state, trumpRevealed: true, pendingTrumpReveal: true };
    case 'PLAY_CARD':
      return applyPlayCard(rules, state, action.card);
    case 'DISCARD_CARD':
      return updatePlayer(state, state.turnSeat, {
        hand: state.players[state.turnSeat]!.hand.filter((c) => c !== action.card),
      });
    case 'TAKE_CARD':
      return updatePlayer(
        { ...state, kitty: state.kitty.filter((c) => c !== action.card) },
        state.turnSeat,
        { hand: [...state.players[state.turnSeat]!.hand, action.card] },
      );
  }
}

// ---------------------------------------------------------------------------
// Bidding turn/round advancement
// ---------------------------------------------------------------------------

function advanceBidding(rules: RulesDsl, state: GameState): GameState {
  if (rules.bidding?.style === 'auction') return advanceAuctionBidding(rules, state);

  const allActed = state.players.every((p) => p.bid !== null);
  if (!allActed) {
    let seat = seatAfter(state, state.turnSeat);
    while (state.players[seat]!.bid !== null) seat = seatAfter(state, seat);
    return { ...state, turnSeat: seat };
  }

  const competitive = Boolean(rules.bidding?.determines.includes('trump-suit'));
  let declarerSeat: SeatIndex | null = null;

  if (competitive) {
    const activeBidders = state.players.filter((p) => p.bid !== null && p.bid >= 0);
    if (activeBidders.length > 0) {
      declarerSeat = activeBidders.reduce((best, p) => (p.bid! > best.bid! ? p : best)).seat;
    } else {
      // Everyone passed — not handled by any v1 game (both plugins guarantee
      // a bid), but fail safe rather than leaving an undecidable state.
      declarerSeat = state.dealerSeat;
    }
  }

  return transitionOutOfBidding(rules, state, declarerSeat);
}

/**
 * Multi-round auction (29): a pass is permanent but a bid is not final —
 * a seat that hasn't passed keeps getting turns and may keep raising. The
 * auction ends the instant only one un-passed seat remains, which is exactly
 * "N-1 consecutive passes" for whatever N this table has, without hardcoding
 * a player count or a fixed number of passing rounds.
 */
function advanceAuctionBidding(rules: RulesDsl, state: GameState): GameState {
  const active = state.players.filter((p) => p.bid !== -1);

  // A lone remaining bidder who hasn't bid yet cannot be allowed to end the
  // auction with no bid on the table (mirrored by generateLegalMoves, which
  // withholds PASS_BID from exactly this seat when dealerMustBid is set) —
  // so the auction keeps going, giving them the turn to bid, rather than
  // ending here with a null declarer bid.
  const lastBidderMustStillAct =
    active.length === 1 && active[0]!.bid === null && rules.bidding?.dealerMustBid === true;

  if (active.length > 1 || lastBidderMustStillAct) {
    let seat = seatAfter(state, state.turnSeat);
    while (state.players[seat]!.bid === -1) seat = seatAfter(state, seat);
    return { ...state, turnSeat: seat };
  }

  // Auction over. The sole un-passed seat is by construction the one holding
  // the high bid (a seat only passes when it declines to take the contract
  // back), so the two agree; `highBidHolder` is consulted first because it is
  // the definition of "who won the auction" and it applies the seniority
  // tie-break introduced by the hold rule. `dealerMustBid` (enforced in
  // generateLegalMoves) guarantees a bid exists in practice, but fail safe to
  // the dealer rather than leaving an undecidable state if a future plugin sets
  // style "auction" without it.
  const declarerSeat: SeatIndex = highBidHolder(state)?.seat ?? active[0]?.seat ?? state.dealerSeat;
  return transitionOutOfBidding(rules, state, declarerSeat);
}

function transitionOutOfBidding(rules: RulesDsl, state: GameState, declarerSeat: SeatIndex | null): GameState {
  const next = nextPhase(rules, state.phase);
  if (next === null) throw new Error(`BIDDING phase "${state.phase}" has no next phase configured`);
  const nextKind = rules.phases.find((p) => p.name === next)!.kind;

  return {
    ...state,
    declarerSeat,
    phase: next,
    turnSeat: nextKind === 'TRUMP_SELECTION' && declarerSeat !== null ? declarerSeat : leftOfDealer(state),
  };
}

function advanceAfterTrumpSelection(rules: RulesDsl, state: GameState): GameState {
  const next = nextPhase(rules, state.phase);
  if (next === null) throw new Error(`TRUMP_SELECTION phase "${state.phase}" has no next phase configured`);
  return { ...state, phase: next, turnSeat: leftOfDealer(state) };
}

// ---------------------------------------------------------------------------
// Trick play
// ---------------------------------------------------------------------------

function applyPlayCard(rules: RulesDsl, state: GameState, card: (typeof state.players)[number]['hand'][number]): GameState {
  const seat = state.turnSeat;
  const isLeading = state.currentTrick.length === 0;
  const playedSuit = parseCard(card).suit;
  const leadSuit = isLeading ? playedSuit : state.leadSuit;

  let next: GameState = updatePlayer(state, seat, {
    hand: state.players[seat]!.hand.filter((c) => c !== card),
  });
  const trick: TrickCard[] = [...next.currentTrick, { seat, card }];
  // Whatever pendingTrumpReveal was owed by this play has now been paid,
  // whether it forced a trump card or there was nothing pending at all.
  next = { ...next, currentTrick: trick, leadSuit, pendingTrumpReveal: false };

  // Court Piece: the hand's opening lead is what fixes trump. `trumpSuit`
  // being null is sufficient to identify that lead — once set it stands for
  // the rest of the hand, and every later trick opens with it already fixed.
  if (rules.trump.mode === 'declared-by-lead' && isLeading && next.trumpSuit === null) {
    next = { ...next, trumpSuit: playedSuit, trumpRevealed: true };
  }

  // A locked suit is "broken" the first time it hits the table, after which it
  // may be led (Hearts). Tracked on play rather than on trick resolution so a
  // suit discarded mid-trick counts immediately, as the real rule does.
  const locked = rules.trickRules.lockedLeadSuits;
  if (locked?.includes(playedSuit) && !next.brokenSuits.includes(playedSuit)) {
    next = { ...next, brokenSuits: [...next.brokenSuits, playedSuit] };
  }

  if (trick.length < next.players.length) {
    return { ...next, turnSeat: seatAfter(next, seat) };
  }

  // Trick complete: resolve winner, award points, reset for the next trick.
  const winnerSeat = resolveTrick(rules, trick, leadSuit!, next.trumpRevealed ? next.trumpSuit : null);
  const points = trickPointValue(rules, trick);
  const winnerTeam = teamKeyForSeat(rules, winnerSeat, next.players.length);

  next = updatePlayer(next, winnerSeat, { tricksWon: next.players[winnerSeat]!.tricksWon + 1 });
  next = {
    ...next,
    currentTrick: [],
    lastTrick: trick,
    // Appended rather than overwritten, so the hand keeps its whole history
    // instead of only the most recent trick. `tricksWon` and `handPoints`
    // above are summaries of exactly this; keeping the source means they stay
    // checkable rather than being the only surviving record.
    completedTricks: [...next.completedTricks, { cards: trick, winnerSeat, leadSuit: leadSuit! }],
    leadSuit: null,
    turnSeat: winnerSeat,
    handPoints: { ...next.handPoints, [winnerTeam]: (next.handPoints[winnerTeam] ?? 0) + points },
  };

  const handComplete = next.players.every((p) => p.hand.length === 0);
  if (handComplete) {
    const scoringPhase = nextPhase(rules, state.phase);
    if (scoringPhase !== null) next = { ...next, phase: scoringPhase };
  }

  return next;
}
