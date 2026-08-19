/**
 * Legal move generation — the deterministic core of the "zero hallucinations"
 * guarantee (PRD 1, 4.2). Every function here is a pure `(rules, state) =>
 * LegalMove[]` computation; nothing here ever calls an LLM or mutates state.
 *
 * Bidding progress is tracked without extending `GameState`: `PlayerState.bid`
 * is `null` (hasn't acted yet), `-1` (passed — permanent in `'auction'` style,
 * see `BiddingConfig.style`), or `>= 0` (a placed bid, which an `'auction'`
 * seat may still raise on a later turn), and `PlayerState.bidOrder` carries the
 * bid seniority that 29's hold rule turns on. This keeps the wire-protocol
 * shape stable across games.
 */

import type { CardId, CompoundCondition, GameState, LegalMove, RulesDsl, Suit } from '@hcg/shared';
import { describeCard, parseCard, SUIT_NAMES } from '@hcg/shared';
import { bidSeniority, highBidHolder } from './state.js';

function currentPlayer(rules: RulesDsl, state: GameState) {
  const player = state.players[state.turnSeat];
  if (!player) throw new Error(`No player at seat ${state.turnSeat}`);
  return player;
}

function phaseKind(rules: RulesDsl, phaseName: string) {
  const phase = rules.phases.find((p) => p.name === phaseName);
  if (!phase) throw new Error(`Unknown phase "${phaseName}"`);
  return phase.kind;
}

// ---------------------------------------------------------------------------
// BIDDING
// ---------------------------------------------------------------------------

function isCompetitiveBidding(rules: RulesDsl): boolean {
  return Boolean(rules.bidding?.determines.includes('trump-suit'));
}

function generateBiddingMoves(rules: RulesDsl, state: GameState): LegalMove[] {
  const bidding = rules.bidding;
  if (!bidding?.enabled) return [];

  const player = currentPlayer(rules, state);
  const auction = bidding.style === 'auction';

  if (auction) {
    if (player.bid === -1) return []; // passed — permanently out of the auction
  } else if (player.bid !== null) {
    return []; // already acted this round
  }

  const moves: LegalMove[] = [];

  // A trick quota can never exceed the number of tricks that will be played,
  // which is the hand size — and hand size varies with table size (Callbreak
  // deals 13 at 4 players but only 8 at 6). Clamp so a 6-player game can't
  // offer an unreachable bid of 13.
  const quotaCeiling = bidding.determines.includes('trick-quota')
    ? Math.min(bidding.maxBid, player.hand.length)
    : bidding.maxBid;

  if (isCompetitiveBidding(rules)) {
    const holder = highBidHolder(state);

    // 29's hold rule: a seat that opened the auction before the current holder
    // may match the holder's number and take the contract back on seniority
    // ("a player can match a previous bid if they placed it first"). Everyone
    // junior to the holder — and the holder itself — must go at least one
    // higher.
    const seniority = bidSeniority(player);
    const mayHold =
      auction &&
      bidding.holdBidBySeniority === true &&
      holder !== null &&
      holder.seat !== player.seat &&
      seniority !== null &&
      seniority < holder.order;

    const floor =
      holder === null
        ? bidding.minBid
        : Math.max(bidding.minBid, mayHold ? holder.value : holder.value + 1);

    for (let value = floor; value <= bidding.maxBid; value++) {
      moves.push({
        id: `bid-${value}`,
        actions: [{ type: 'PLACE_BID', value }],
        label: mayHold && value === holder.value ? `Hold at ${value}` : `Bid ${value}`,
      });
    }
    // Auction style: if everyone else has already passed and this seat has
    // never bid, the auction cannot be allowed to end with no bid on the
    // table — no pass is offered, forcing a bid.
    const forcedToBid =
      auction &&
      bidding.dealerMustBid === true &&
      player.bid === null &&
      state.players.filter((p) => p.bid !== -1).length === 1;

    if (bidding.allowPass && !forcedToBid) {
      moves.push({ id: 'pass', actions: [{ type: 'PASS_BID' }], label: 'Pass' });
    }
  } else {
    // Non-competitive: each seat stakes an independent quota (Callbreak).
    for (let value = bidding.minBid; value <= quotaCeiling; value++) {
      moves.push({
        id: `bid-${value}`,
        actions: [{ type: 'PLACE_BID', value }],
        label: `Bid ${value} trick${value === 1 ? '' : 's'}`,
      });
    }
    if (bidding.allowPass) {
      moves.push({ id: 'pass', actions: [{ type: 'PASS_BID' }], label: 'Pass' });
    }
  }

  return applyExactTotalHook(rules, state, moves);
}

/**
 * Oh Hell's hook rule (`bidding.forbidExactTotal`): the final seat to bid may
 * not pick the number that makes the table's bids add up to exactly the tricks
 * available, so at least one contract has to fail every hand. Enforced by
 * withholding that one option rather than rejecting it after the fact, which
 * keeps the "pick from a bounded list" contract intact for the LLM.
 */
function applyExactTotalHook(rules: RulesDsl, state: GameState, moves: LegalMove[]): LegalMove[] {
  if (rules.bidding?.forbidExactTotal !== true) return moves;

  const yetToBid = state.players.filter((p) => p.bid === null);
  if (yetToBid.length !== 1 || yetToBid[0]!.seat !== state.turnSeat) return moves;

  const tricksAvailable = state.players[state.turnSeat]!.hand.length;
  const alreadyBid = state.players.reduce((sum, p) => sum + (p.bid !== null && p.bid > 0 ? p.bid : 0), 0);
  const forbidden = tricksAvailable - alreadyBid;
  if (forbidden < 0) return moves;

  const filtered = moves.filter((m) => {
    const bid = m.actions.find((a) => a.type === 'PLACE_BID');
    return bid === undefined || bid.value !== forbidden;
  });
  // Never hand back an empty move list: if the hook would leave this seat with
  // nothing to do, the rule yields rather than deadlocking the hand.
  return filtered.length > 0 ? filtered : moves;
}

// ---------------------------------------------------------------------------
// TRUMP_SELECTION
// ---------------------------------------------------------------------------

function generateTrumpSelectionMoves(rules: RulesDsl, state: GameState): LegalMove[] {
  // The modes where a seat actively names the suit. `static`/`none`/
  // `kitty-turnup` resolved at deal time and `declared-by-lead` resolves on
  // the opening lead, so none of them ever reaches this phase with a choice
  // to make.
  const SELECTABLE = ['hidden', 'bid-selected', 'chooser'];
  if (!SELECTABLE.includes(rules.trump.mode)) return [];
  if (state.declarerSeat === null || state.turnSeat !== state.declarerSeat) return [];
  if (state.trumpSuit !== null) return []; // already chosen

  const concealed = rules.trump.mode === 'hidden';
  return rules.deck.suits.map((suit) => ({
    id: `trump-${suit}`,
    actions: [{ type: 'SELECT_TRUMP', suit, concealed }],
    label: concealed
      ? `Fix ${SUIT_NAMES[suit]} as trump (concealed)`
      : `Select ${SUIT_NAMES[suit]} as trump`,
  }));
}

// ---------------------------------------------------------------------------
// PLAYING
// ---------------------------------------------------------------------------

/**
 * Cards this seat may *lead*. Normally the whole hand, but a game with
 * `lockedLeadSuits` (Hearts) withholds those suits until one has been played
 * off-lead. A seat holding nothing else may lead a locked suit anyway — the
 * rule exists to delay the suit, not to leave a player with no move.
 */
function leadOptions(rules: RulesDsl, hand: readonly CardId[], brokenSuits: readonly Suit[]): CardId[] {
  const locked = rules.trickRules.lockedLeadSuits;
  if (!locked || locked.length === 0) return [...hand];

  const stillLocked = locked.filter((s) => !brokenSuits.includes(s));
  if (stillLocked.length === 0) return [...hand];

  const unlocked = hand.filter((c) => !stillLocked.includes(parseCard(c).suit));
  return unlocked.length > 0 ? unlocked : [...hand];
}

/** Cards in `hand` that are legal to play, given the lead suit and trump-visibility rules. */
function followSuitOptions(
  rules: RulesDsl,
  hand: readonly CardId[],
  leadSuit: Suit | null,
  effectiveTrump: Suit | null,
  forceMustTrump = false,
  brokenSuits: readonly Suit[] = [],
): CardId[] {
  if (leadSuit === null) return leadOptions(rules, hand, brokenSuits);

  const inSuit = hand.filter((c) => parseCard(c).suit === leadSuit);
  if (rules.trickRules.mustFollowSuit && inSuit.length > 0) return inSuit;

  // Void in the led suit. `forceMustTrump` is the seat's own
  // `mustTrumpAfterOwnReveal` obligation for the play that immediately
  // follows a non-atomic reveal; it applies regardless of the general
  // `mustTrumpIfVoid` setting.
  if ((rules.trickRules.mustTrumpIfVoid || forceMustTrump) && effectiveTrump !== null) {
    const trumps = hand.filter((c) => parseCard(c).suit === effectiveTrump);
    if (trumps.length > 0) return trumps;
  }

  if (rules.trickRules.freeDiscardIfVoidAndNoTrump) return [...hand];
  return [...hand]; // no further restriction modeled in v1
}

/** A single `CompoundCondition` against the current decision point. */
function conditionHolds(
  condition: CompoundCondition,
  state: GameState,
  player: GameState['players'][number],
  leadSuit: Suit | null,
): boolean {
  switch (condition.kind) {
    case 'hand-is-void-in-lead-suit':
      return leadSuit !== null && !player.hand.some((c) => parseCard(c).suit === leadSuit);
    case 'trump-not-yet-revealed':
      return true; // callers already gate on `!state.trumpRevealed` before reaching here
    case 'player-is-declarer':
      return state.declarerSeat === state.turnSeat;
  }
}

function generatePlayingMoves(rules: RulesDsl, state: GameState): LegalMove[] {
  const player = currentPlayer(rules, state);
  const leadSuit = state.leadSuit;
  const isLeading = state.currentTrick.length === 0;
  const effectiveTrump = state.trumpRevealed ? state.trumpSuit : null;

  // A seat that just fired a non-atomic REVEAL_TRUMP owes this trick a trump
  // card (if it holds one) before it can play anything else.
  const forceMustTrump = state.pendingTrumpReveal && rules.trickRules.mustTrumpAfterOwnReveal === true;

  const standardOptions = followSuitOptions(
    rules,
    player.hand,
    leadSuit,
    effectiveTrump,
    forceMustTrump,
    state.brokenSuits,
  );

  const moves: LegalMove[] = standardOptions.map((card) => ({
    id: `play-${card}`,
    actions: [{ type: 'PLAY_CARD', card }],
    label: `Play ${describeCard(card)}`,
  }));

  // Requirement A (PRD 4.2): compound actions, atomic or split. Reveal is
  // never offered mid-obligation — a seat that still owes a forced trump play
  // has already revealed and must resolve that first.
  if (!isLeading && !state.trumpRevealed && !forceMustTrump && rules.compoundActions) {
    for (const rule of rules.compoundActions) {
      if (rule.triggerPhase !== state.phase) continue;
      if (!rule.actionSequence.includes('REVEAL_TRUMP')) continue;
      if (!rule.conditions.every((c) => conditionHolds(c, state, player, leadSuit))) continue;
      if (state.trumpSuit === null) continue;

      if (rule.atomic === false) {
        // Split: reveal is its own move. The engine re-generates legal moves
        // for this same seat immediately after (REVEAL_TRUMP never advances
        // turnSeat), so the card choice becomes a separate decision made
        // with trump now visible — and, if `mustTrumpAfterOwnReveal` is set,
        // constrained to trump above. The label deliberately never names the
        // suit: revealing is what *discovers* it, both for the UI and for the
        // LLM prompt built from this same label — printing it here would leak
        // the hidden suit to anyone offered the move before they've chosen to
        // expose it (fog-of-war already withholds `trumpSuit` itself for
        // exactly this reason; the move label must not become a side channel
        // around that).
        moves.push({
          id: `${rule.id}-reveal`,
          actions: [{ type: 'REVEAL_TRUMP' }],
          label: 'Reveal trump',
          tags: ['reveals-trump'],
        });
        continue;
      }

      // Atomic (default): fused into one indivisible reveal-then-play choice.
      // Same no-suit-in-the-label reasoning as the split case above.
      const optionsIfRevealed = followSuitOptions(rules, player.hand, leadSuit, state.trumpSuit);
      for (const card of optionsIfRevealed) {
        moves.push({
          id: `${rule.id}-${card}`,
          actions: [{ type: 'REVEAL_TRUMP' }, { type: 'PLAY_CARD', card }],
          label: `Reveal trump and play ${describeCard(card)}`,
          tags: ['compound', 'reveals-trump'],
        });
      }
    }
  }

  return moves;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function generateLegalMoves(rules: RulesDsl, state: GameState): LegalMove[] {
  if (state.activeMicroPhase) {
    // Micro-phase steps (Requirement B) are resolved by generateMicroPhaseMoves
    // in micro-phase.ts once a plugin declares one; no v1 game needs it yet.
    return [];
  }

  const kind = phaseKind(rules, state.phase);
  switch (kind) {
    case 'DEALING':
      return []; // instantaneous, handled by createMatch + phase auto-advance
    case 'BIDDING':
      return generateBiddingMoves(rules, state);
    case 'TRUMP_SELECTION':
      return generateTrumpSelectionMoves(rules, state);
    case 'CARD_EXCHANGE':
      return []; // driven by microPhases; no v1 game reaches this without one
    case 'PLAYING':
      return generatePlayingMoves(rules, state);
    case 'SCORING':
      return []; // resolved automatically by the engine, not a player choice
  }
}
