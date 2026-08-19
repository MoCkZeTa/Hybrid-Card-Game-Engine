/**
 * Hand-end scoring. Folds this hand's captured value (`state.handPoints` for
 * points-contract games, `tricksWon` for tricks-contract games) into the
 * persistent `teamScores`, and builds the `ResultSummary` the client turns into
 * a round/game-over popup.
 *
 * Which payout curve applies comes from `rules.scoring.formula` — a named
 * formula plus constants, resolved by `scoringFormula` with a per-basis default
 * so a plugin written before the field existed scores exactly as it used to.
 * Nothing here is keyed to a gameId; a plugin imported at runtime picks its
 * curve out of the same table the shipped games do.
 */

import type {
  ContractOutcome,
  GameEndReason,
  GameState,
  ResultRow,
  ResultSummary,
  RulesDsl,
  ScoringFormula,
  SeatIndex,
} from '@hcg/shared';
import { formulaHasContract, handLimit, scoringFormula } from '@hcg/shared';
import { allTeamKeys, teamKeyForSeat } from './state.js';
import { buildDeck } from './deck.js';
import { totalPointsInDeck } from './trick.js';

type Scores = Record<string, number>;

/** One competitor's raw hand performance, before any formula is applied to it. */
interface Captured {
  readonly key: string;
  readonly seats: readonly SeatIndex[];
  /** Combined contract for this competitor, or null if nobody on it bid. Nil bids are excluded — they are scored on their own terms. */
  readonly bid: number | null;
  /** What they took this hand, in whatever unit `contractBasis` names. */
  readonly made: number;
  /** Seats on this competitor that bid nil, with whether each kept it. */
  readonly nils: readonly { readonly seat: SeatIndex; readonly kept: boolean }[];
}

/**
 * Applies this hand's scoring and attaches the result. `lastResult.scope` is
 * `GAME` when this was the final hand, which is also the signal to the match
 * manager not to deal another.
 */
export function applyHandScoring(rules: RulesDsl, state: GameState): GameState {
  const before = state.teamScores;
  const { scores, bags } = computeScores(rules, state);
  const lastResult = buildResult(rules, state, before, scores);
  return { ...state, teamScores: scores, bags, lastResult };
}

// ---------------------------------------------------------------------------
// Capture tallies
// ---------------------------------------------------------------------------

/** What each competitor captured this hand, independent of how it will be scored. */
function tallyCaptured(rules: RulesDsl, state: GameState): Captured[] {
  const playerCount = state.players.length;
  const basis = rules.scoring.contractBasis;
  const nilBid = rules.scoring.nil?.bid;

  return allTeamKeys(rules, playerCount).map((key) => {
    const members = state.players.filter((p) => teamKeyForSeat(rules, p.seat, playerCount) === key);

    const nils = nilBid === undefined
      ? []
      : members
          .filter((p) => p.bid === nilBid)
          .map((p) => ({ seat: p.seat, kept: p.tricksWon === 0 }));

    // A nil bid is not part of the side's trick contract — it is a separate
    // wager scored on its own — but the tricks a nil bidder takes still land on
    // the side, which is what makes a broken nil doubly expensive.
    const contractBids = members
      .map((p) => p.bid)
      .filter((b): b is number => b !== null && b >= 0 && b !== nilBid);

    return {
      key,
      seats: members.map((p) => p.seat),
      bid: contractBids.length === 0 ? null : contractBids.reduce((a, b) => a + b, 0),
      made: basis === 'points'
        ? (state.handPoints[key] ?? 0)
        : members.reduce((sum, p) => sum + p.tricksWon, 0),
      nils,
    };
  });
}

// ---------------------------------------------------------------------------
// The formulas
// ---------------------------------------------------------------------------

interface ScoreOutcome {
  readonly scores: Scores;
  readonly bags: Readonly<Record<string, number>>;
}

function computeScores(rules: RulesDsl, state: GameState): ScoreOutcome {
  const formula = scoringFormula(rules);
  const scores: Scores = { ...state.teamScores };
  const bags: Record<string, number> = { ...state.bags };
  if (formula === null) return { scores, bags }; // contractBasis 'none': no formula defined

  const captured = tallyCaptured(rules, state);
  const deltas = handDeltas(rules, state, formula, captured);

  for (const [key, delta] of Object.entries(deltas)) {
    scores[key] = (scores[key] ?? 0) + delta;
  }

  // Bags accrue from overtricks and are paid off in whole lumps; the remainder
  // rides to the next hand, which is the entire point of tracking them.
  const bagRule = rules.scoring.bags;
  if (bagRule && formula.kind === 'bid-multiplier') {
    for (const c of captured) {
      // A broken nil's tricks are already inside `made`, so they surface as
      // overtricks here without needing to be counted a second time. With no
      // contract at all (everyone on the side bid nil) every trick is a bag.
      const earned = c.bid === null ? c.made : Math.max(0, c.made - c.bid);
      const running = (bags[c.key] ?? 0) + earned;
      const lumps = Math.floor(running / bagRule.per);
      bags[c.key] = running - lumps * bagRule.per;
      scores[c.key] = (scores[c.key] ?? 0) - lumps * bagRule.penalty;
    }
  }

  return { scores, bags };
}

/** This hand's score change per competitor, before bag penalties are settled. */
function handDeltas(
  rules: RulesDsl,
  state: GameState,
  formula: ScoringFormula,
  captured: readonly Captured[],
): Scores {
  const deltas: Scores = {};
  for (const c of captured) deltas[c.key] = 0;

  const nilRule = rules.scoring.nil;
  const addNil = (c: Captured): number =>
    nilRule === undefined
      ? 0
      : c.nils.reduce((sum, n) => sum + (n.kept ? nilRule.bonus : -nilRule.penalty), 0);

  switch (formula.kind) {
    case 'bid-plus-overtrick-fraction': {
      // Callbreak. Scored per seat rather than per competitor, because each
      // seat contracts independently even in a game that groups seats for the
      // scoreboard.
      const overtrickValue = formula.overtrickValue ?? 0.1;
      const playerCount = state.players.length;
      for (const player of state.players) {
        const key = teamKeyForSeat(rules, player.seat, playerCount);
        const bid = player.bid ?? 0;
        const made = player.tricksWon;
        deltas[key] = (deltas[key] ?? 0) + (made >= bid ? bid + (made - bid) * overtrickValue : -bid);
      }
      break;
    }

    case 'bid-multiplier': {
      // Spades. The side's bids combine into one contract; overtricks pay a
      // trickle now and a bag penalty later.
      for (const c of captured) {
        if (c.bid !== null) {
          deltas[c.key] =
            c.made >= c.bid
              ? c.bid * formula.madeMultiplier + (c.made - c.bid) * formula.overtrickValue
              : c.bid * formula.missMultiplier;
        }
        deltas[c.key] = (deltas[c.key] ?? 0) + addNil(c);
      }
      break;
    }

    case 'exact-bid': {
      // Oh Hell. Per seat, and the bid is a bullseye rather than a floor.
      const playerCount = state.players.length;
      for (const player of state.players) {
        const key = teamKeyForSeat(rules, player.seat, playerCount);
        const bid = player.bid ?? 0;
        const error = Math.abs(player.tricksWon - bid);
        deltas[key] =
          (deltas[key] ?? 0) +
          (error === 0 ? formula.base + formula.perTrick * player.tricksWon : formula.missPerTrick * error);
      }
      break;
    }

    case 'bid-difference': {
      // 3-2-5. The signed distance from the quota: a seat owing 3 that takes 6
      // gains 3, and one that takes 2 loses 1. Per seat.
      const playerCount = state.players.length;
      for (const player of state.players) {
        const key = teamKeyForSeat(rules, player.seat, playerCount);
        deltas[key] = (deltas[key] ?? 0) + (player.tricksWon - (player.bid ?? 0));
      }
      break;
    }

    case 'threshold-win': {
      // Mendicot, Court Piece. Clearing the bar is the whole result; the margin
      // beyond it earns nothing.
      for (const c of captured) {
        deltas[c.key] = c.made >= formula.threshold ? formula.value : 0;
      }
      break;
    }

    case 'declarer-contract': {
      // 29. Only the declaring side contracts anything.
      if (state.declarerSeat === null) {
        throw new Error('scoring formula "declarer-contract" requires a declarerSeat to evaluate the contract');
      }
      const declarerKey = teamKeyForSeat(rules, state.declarerSeat, state.players.length);
      const declarerBid = state.players[state.declarerSeat]?.bid ?? rules.bidding?.minBid ?? 0;
      const declarer = captured.find((c) => c.key === declarerKey);
      const madeContract = (declarer?.made ?? 0) >= declarerBid;
      // 29 plays for one game point however high the bid was, so the stake is
      // not necessarily the contract's size.
      const stake = formula.stake === undefined || formula.stake === 'bid' ? declarerBid : formula.stake;

      for (const c of captured) {
        if (c.key === declarerKey) {
          deltas[c.key] = madeContract ? stake : -stake;
        } else if (formula.defenders !== 'unaffected') {
          deltas[c.key] = madeContract ? -stake : stake;
        }
      }
      break;
    }

    case 'capture': {
      // Mendicot, Court Piece, Whist. No contract at all — score what you took,
      // optionally only the excess over a threshold (Whist's six-trick book).
      const threshold = formula.threshold ?? 0;
      for (const c of captured) deltas[c.key] = Math.max(0, c.made - threshold);
      break;
    }

    case 'penalty-points': {
      // Hearts. Captured points count against you, and taking every one of them
      // inverts the hand instead of ending it catastrophically.
      const total = captured.reduce((sum, c) => sum + c.made, 0);
      const shooter = findMoonShooter(rules, state, captured, total);

      for (const c of captured) {
        if (shooter === null) {
          deltas[c.key] = c.made;
        } else if (rules.scoring.moonShot?.mode === 'shooter-subtracts') {
          deltas[c.key] = c.key === shooter ? -total : 0;
        } else {
          deltas[c.key] = c.key === shooter ? 0 : total;
        }
      }
      break;
    }
  }

  return deltas;
}

/**
 * The competitor that shot the moon, or null if nobody did.
 *
 * "Every penalty point in the hand" is measured against the deck rather than
 * against what was dealt, so a competitor cannot shoot by default in a deal
 * where some penalty cards sat in the kitty and were never winnable.
 */
function findMoonShooter(
  rules: RulesDsl,
  state: GameState,
  captured: readonly Captured[],
  totalCaptured: number,
): string | null {
  if (!rules.scoring.moonShot) return null;
  if (totalCaptured <= 0) return null;
  if (totalCaptured !== totalPointsInDeck(rules, buildDeck(rules))) return null;
  if (captured.length < 2) return null;

  const holder = captured.find((c) => c.made === totalCaptured);
  return holder?.key ?? null;
}

// ---------------------------------------------------------------------------
// Result construction
// ---------------------------------------------------------------------------

/**
 * Whether the match is over after the hand that just scored, and why.
 *
 * Both conditions are read straight from the DSL, so match length is a plugin
 * decision rather than anything this engine knows about a specific game. Note
 * that a `lowerIsBetter` game still *ends* on someone reaching `targetScore` —
 * reaching it is what loses you the game rather than what wins it.
 */
export function matchEndReason(
  rules: RulesDsl,
  handNumber: number,
  scores: Scores,
  maxHandsOverride: number | null = null,
): GameEndReason | null {
  const { targetScore } = rules.scoring;
  if (targetScore !== undefined && Object.values(scores).some((v) => v >= targetScore)) {
    return 'target-score';
  }
  return handNumber >= handLimit(rules, maxHandsOverride) ? 'hand-limit' : null;
}

/**
 * Builds the result table for the hand that just scored. Every value is
 * derived from the rules DSL and the two score snapshots, so an imported
 * plugin the client has never seen still renders a correct popup.
 */
function buildResult(rules: RulesDsl, state: GameState, before: Scores, after: Scores): ResultSummary {
  const playerCount = state.players.length;
  const basis = rules.scoring.contractBasis;
  const formula = scoringFormula(rules);
  const isPairs = rules.players.topology === 'fixed-pairs';
  const lowerIsBetter = rules.scoring.lowerIsBetter === true;
  const hasContract = formulaHasContract(formula);

  const declarerKey =
    state.declarerSeat === null ? null : teamKeyForSeat(rules, state.declarerSeat, playerCount);
  const captured = tallyCaptured(rules, state);
  const declarerBid =
    state.declarerSeat === null ? null : (state.players[state.declarerSeat]?.bid ?? null);
  const declarerMadeIt =
    declarerKey === null || declarerBid === null
      ? null
      : (captured.find((c) => c.key === declarerKey)?.made ?? 0) >= declarerBid;

  const partial = captured.map((c, teamIndex) => {
    const members = c.seats.map((seat) => state.players[seat]!);
    const isDeclarer = declarerKey !== null && c.key === declarerKey;

    // What "the bid" means depends on the formula. A declarer-contract game has
    // exactly one contract on the table, so showing the defenders a bid would
    // be inventing one; every other contract formula gives each side its own.
    const bid = !hasContract
      ? null
      : formula?.kind === 'declarer-contract'
        ? (isDeclarer ? declarerBid : null)
        : c.bid;

    return {
      key: c.key,
      label: isPairs ? `Team ${teamIndex + 1}` : (members[0]?.name ?? c.key),
      seats: c.seats,
      playerNames: members.map((p) => p.name),
      bid,
      made: c.made,
      delta: round2((after[c.key] ?? 0) - (before[c.key] ?? 0)),
      total: round2(after[c.key] ?? 0),
      isDeclarer,
      contract: contractOutcome(formula, bid, c.made, isDeclarer, declarerMadeIt),
    };
  });

  // Best-first, so the client can render rows in order without re-sorting, and
  // "best" flips for a penalty game. Ties share a rank (1, 1, 3 — not 1, 2, 3).
  const better = (a: number, b: number): number => (lowerIsBetter ? a - b : b - a);
  const sorted = [...partial].sort((a, b) => better(a.total, b.total));
  const rows: ResultRow[] = sorted.map((row) => ({
    ...row,
    rank: sorted.findIndex((r) => r.total === row.total) + 1,
  }));

  const pick = (values: number[]): number => (lowerIsBetter ? Math.min(...values) : Math.max(...values));
  const bestDelta = pick(partial.map((r) => r.delta));
  const bestTotal = pick(partial.map((r) => r.total));
  const endReason = matchEndReason(rules, state.handNumber, after, state.maxHandsOverride);
  const limit = handLimit(rules, state.maxHandsOverride);

  return {
    scope: endReason === null ? 'ROUND' : 'GAME',
    handNumber: state.handNumber,
    // A target-score game has no fixed length, so the client shows "Round 3"
    // rather than "Round 3 of N" — unless the host pinned a length, which
    // gives it one.
    totalHands:
      state.maxHandsOverride ??
      rules.scoring.maxHands ??
      (rules.scoring.targetScore === undefined ? limit : null),
    basis,
    rows,
    roundWinnerKeys: partial.filter((r) => r.delta === bestDelta).map((r) => r.key),
    winnerKeys: partial.filter((r) => r.total === bestTotal).map((r) => r.key),
    endReason,
  };
}

function contractOutcome(
  formula: ScoringFormula | null,
  bid: number | null,
  made: number,
  isDeclarer: boolean,
  declarerMadeIt: boolean | null,
): ContractOutcome | null {
  if (!formulaHasContract(formula) || formula === null) return null;

  if (formula.kind === 'declarer-contract') {
    // Only the declaring side has a contract. The defenders are shown the
    // mirror image — they "made it" precisely when the declarer did not.
    if (declarerMadeIt === null) return null;
    return isDeclarer ? (declarerMadeIt ? 'MADE' : 'MISSED') : declarerMadeIt ? 'MISSED' : 'MADE';
  }
  if (bid === null) return null;
  // An exact-bid game is the one place overtricks are a failure, not a bonus.
  if (formula.kind === 'exact-bid') return made === bid ? 'MADE' : 'MISSED';
  return made >= bid ? 'MADE' : 'MISSED';
}

/** Tricks-basis scoring produces tenths (overtricks are worth 0.1) — keep float noise out of the wire payload. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
