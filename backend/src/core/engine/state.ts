/**
 * Initial-state construction and small state-derived helpers shared by the
 * engine, the move generator, and the fog-of-war serializer.
 *
 * Everything here takes the table size from the live state (or an explicit
 * argument) rather than from a fixed value in `rules`, so a plugin that
 * supports a range of player counts works without special-casing.
 */

import type { CardId, GameState, PlayerState, RulesDsl, SeatIndex, Suit } from '@hcg/shared';
import { parseCard, resolveTeams, supportedPlayerCounts } from '@hcg/shared';
import { deal, type Rng } from './deck.js';

/** Number of seats at the table for a given state. */
export function seatCount(state: GameState): number {
  return state.players.length;
}

/**
 * Team key for a seat, used as the key into `teamScores`. Fixed-pairs games
 * group partners under one key; solo games give every seat its own key so
 * scores are tracked individually.
 */
export function teamKeyForSeat(rules: RulesDsl, seat: SeatIndex, playerCount: number): string {
  if (rules.players.topology === 'fixed-pairs') {
    const teams = resolveTeams(rules, playerCount);
    if (!teams) {
      throw new Error(`No team layout defined for ${playerCount} players in game "${rules.displayName}"`);
    }
    const teamIndex = teams.findIndex((team) => team.includes(seat));
    if (teamIndex === -1) throw new Error(`Seat ${seat} is not assigned to any team at ${playerCount} players`);
    return `team-${teamIndex}`;
  }
  return `seat-${seat}`;
}

export function allTeamKeys(rules: RulesDsl, playerCount: number): string[] {
  if (rules.players.topology === 'fixed-pairs') {
    const teams = resolveTeams(rules, playerCount) ?? [];
    return teams.map((_, i) => `team-${i}`);
  }
  return Array.from({ length: playerCount }, (_, seat) => `seat-${seat}`);
}

// ---------------------------------------------------------------------------
// Bidding-state helpers (see PlayerState.bidOrder)
// ---------------------------------------------------------------------------

/**
 * A seat's bid seniority, or null if it has never bid. Reads the field
 * defensively because a match snapshot persisted before `bidOrder` existed
 * comes back with it absent rather than null.
 */
export function bidSeniority(player: PlayerState): number | null {
  return typeof player.bidOrder === 'number' ? player.bidOrder : null;
}

/** Seniority number to stamp on the next seat that opens a bid this hand. */
export function nextBidOrder(state: GameState): number {
  return state.players.filter((p) => bidSeniority(p) !== null).length;
}

/**
 * The seat that currently owns the contract, or null if nobody has bid.
 *
 * Ties are possible only because of the hold rule (`holdBidBySeniority`): two
 * seats can sit on the same number, and the one that opened first owns it. That
 * makes seniority the tie-break, which is what "a player can match a previous
 * bid if they placed it first" means once the match has been made.
 */
export function highBidHolder(
  state: GameState,
): { readonly seat: SeatIndex; readonly value: number; readonly order: number } | null {
  let best: { seat: SeatIndex; value: number; order: number } | null = null;
  for (const p of state.players) {
    if (p.bid === null || p.bid < 0) continue;
    const order = bidSeniority(p) ?? Number.MAX_SAFE_INTEGER;
    if (best === null || p.bid > best.value || (p.bid === best.value && order < best.order)) {
      best = { seat: p.seat, value: p.bid, order };
    }
  }
  return best;
}

export interface CreateMatchOptions {
  readonly rules: RulesDsl;
  /**
   * Identity of the plugin these rules came from, recorded on the state so a
   * persisted match can be matched back to its game. Passed in rather than read
   * off `rules` because the DSL deliberately carries no id — see `RulesDsl`.
   */
  readonly gameId: string;
  readonly matchId: string;
  readonly playerCount: number;
  readonly dealerSeat: SeatIndex;
  readonly playerNames: readonly string[];
  readonly aiSeats: ReadonlySet<SeatIndex>;
  readonly rng: Rng;
  /** Host's chosen match length; omitted uses the plugin's own declaration. */
  readonly maxHands?: number | null;
}

export function createMatch(opts: CreateMatchOptions): GameState {
  const { rules, gameId, matchId, playerCount, dealerSeat, playerNames, aiSeats, rng } = opts;

  const supported = supportedPlayerCounts(rules);
  if (!supported.includes(playerCount)) {
    throw new Error(
      `"${rules.displayName}" supports ${supported.join('/')} players, not ${playerCount}`,
    );
  }
  if (playerNames.length !== playerCount) {
    throw new Error(`Expected ${playerCount} player names, got ${playerNames.length}`);
  }

  const players: PlayerState[] = Array.from({ length: playerCount }, (_, seat) => ({
    seat,
    name: playerNames[seat]!,
    isAI: aiSeats.has(seat),
    hand: [],
    tricksWon: 0,
    bid: null,
    bidOrder: null,
  }));

  const teamScores: Record<string, number> = {};
  const bags: Record<string, number> = {};
  for (const key of allTeamKeys(rules, playerCount)) {
    teamScores[key] = 0;
    bags[key] = 0;
  }

  return dealHand(rules, {
    gameId,
    matchId,
    phase: rules.phases[0]?.name ?? '',
    dealerSeat,
    turnSeat: (dealerSeat + 1) % playerCount,
    declarerSeat: null,
    trumpSuit: null,
    trumpRevealed: false,
    pendingTrumpReveal: false,
    players,
    currentTrick: [],
    lastTrick: null,
    leadSuit: null,
    kitty: [],
    teamScores,
    bags,
    brokenSuits: [],
    handPoints: {},
    handNumber: 1,
    maxHandsOverride: opts.maxHands ?? null,
    activeMicroPhase: null,
    lastResult: null,
  }, dealerSeat, 1, rng);
}

/**
 * Deals the next hand of an in-progress match: fresh cards, dealer moves one
 * seat left, per-hand state (bids, tricks, trump, captured points, the
 * previous result) resets — and `teamScores`, seat ownership and player names
 * carry over. This is the multi-hand counterpart to `createMatch`.
 */
export function startNextHand(rules: RulesDsl, state: GameState, rng: Rng): GameState {
  const playerCount = state.players.length;
  const dealerSeat = (state.dealerSeat + 1) % playerCount;
  return dealHand(rules, state, dealerSeat, state.handNumber + 1, rng);
}

/**
 * The shared per-hand reset. Everything a new hand must clear lives here so a
 * re-deal can never drift from a first deal — the only difference between the
 * two is which fields the caller carried in.
 */
/**
 * The trump situation the moment a hand is dealt, before anyone acts.
 *
 * Three of the seven modes resolve immediately at deal time and the rest wait
 * for something to happen — an auction, a chooser, or the opening lead — so
 * they start null and are filled in later by `apply-move`.
 */
function initialTrump(
  rules: RulesDsl,
  kitty: readonly CardId[],
): { suit: Suit | null; revealed: boolean } {
  switch (rules.trump.mode) {
    case 'static':
      return { suit: rules.trump.staticSuit ?? null, revealed: true };
    case 'none':
      // Revealed, because there is nothing left to find out. Trick resolution
      // reads a null suit as "no card can trump", which is exactly right.
      return { suit: null, revealed: true };
    case 'kitty-turnup': {
      const turnup = kitty[0];
      if (turnup === undefined) {
        throw new Error(
          `"${rules.displayName}" uses trump.mode "kitty-turnup" but this deal left no kitty card to turn up`,
        );
      }
      return { suit: parseCard(turnup).suit, revealed: true };
    }
    default:
      return { suit: null, revealed: false };
  }
}

/** The seat that names trump before play in a `chooser` game, or null for every other mode. */
function chooserSeat(rules: RulesDsl, dealerSeat: SeatIndex, playerCount: number): SeatIndex | null {
  if (rules.trump.mode !== 'chooser') return null;
  return (dealerSeat + (rules.trump.chooserDealerOffset ?? 0)) % playerCount;
}

function dealHand(
  rules: RulesDsl,
  base: GameState,
  dealerSeat: SeatIndex,
  handNumber: number,
  rng: Rng,
): GameState {
  const playerCount = base.players.length;
  const { hands, kitty } = deal(rules, playerCount, rng, handNumber);

  const handPoints: Record<string, number> = {};
  for (const key of allTeamKeys(rules, playerCount)) handPoints[key] = 0;

  const firstPhase = rules.phases[0];
  if (!firstPhase) throw new Error('rules.phases is empty — should have been rejected by validateRulesDsl');

  // DEALING is instantaneous — the deal already happened above — so skip
  // straight past it to the first phase that actually asks a player to decide
  // something. Any further auto-advance (e.g. an empty BIDDING) is not a v1
  // case and is deliberately left to surface as an explicit error.
  const startPhase =
    firstPhase.kind === 'DEALING' ? (nextPhase(rules, firstPhase.name) ?? firstPhase.name) : firstPhase.name;

  const trump = initialTrump(rules, kitty);
  const chooser = chooserSeat(rules, dealerSeat, playerCount);

  // A game with no bidding can still hand out contracts: 3-2-5 fixes them by
  // seat position. Stamping them onto `bid` here means every downstream
  // contract check — scoring, the result table, the AI prompt — treats them as
  // ordinary bids and needs no idea they came from somewhere else.
  const quotas = rules.scoring.fixedQuotasByDealerOffset;
  const quotaForSeat = (seat: SeatIndex): number | null =>
    quotas ? (quotas[(seat - dealerSeat + playerCount) % playerCount] ?? null) : null;

  return {
    ...base,
    phase: startPhase,
    dealerSeat,
    // The chooser names trump before anyone leads, so it acts first; otherwise
    // play opens on the dealer's left as usual.
    turnSeat: chooser ?? (dealerSeat + 1) % playerCount,
    declarerSeat: chooser,
    trumpSuit: trump.suit,
    trumpRevealed: trump.revealed,
    pendingTrumpReveal: false,
    players: base.players.map((p) => ({
      ...p,
      hand: hands[p.seat]!,
      tricksWon: 0,
      bid: quotaForSeat(p.seat),
      bidOrder: null,
    })),
    currentTrick: [],
    lastTrick: null,
    leadSuit: null,
    kitty,
    brokenSuits: [],
    handPoints,
    handNumber,
    activeMicroPhase: null,
    lastResult: null,
  };
}

export function nextPhase(rules: RulesDsl, currentPhaseName: string): string | null {
  const phase = rules.phases.find((p) => p.name === currentPhaseName);
  if (!phase) throw new Error(`Unknown phase "${currentPhaseName}"`);
  return phase.next;
}
