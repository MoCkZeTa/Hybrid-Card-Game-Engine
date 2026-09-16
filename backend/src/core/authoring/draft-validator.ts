/**
 * The gate every AI-authored draft passes before a human is asked to look at
 * it — and the thing that makes this feature honest rather than a demo.
 *
 * `validateRulesDsl` alone is not enough here. It answers "is this document
 * structurally well-formed", which is the right question for a file a person
 * hand-wrote and can debug. A model produces a different failure: a document
 * that satisfies every field constraint and still cannot be *played* — a
 * bidding phase with no BIDDING kind so the auction never runs, a fixed deal
 * whose arithmetic leaves a seat with no cards, a phase chain that loops back
 * on itself. Those all validate and then deadlock a real match.
 *
 * So a draft is checked the only way that actually proves anything: the engine
 * deals it and plays it. Same `createMatch` / `generateLegalMoves` / `applyMove`
 * / `applyHandScoring` loop the WebSocket server runs, driven deterministically
 * by always taking the first legal move, at every table size the plugin claims
 * to support. This is exactly what `game-library.test.ts` does to the shipped
 * plugin catalog; the designer holds its own output to the same bar.
 *
 * Nothing here mutates anything or touches the network — it is a pure function
 * from a candidate document to a verdict, which is what lets the designer call
 * it in a repair loop.
 */

import {
  handLimit,
  resolveDeal,
  supportedPlayerCounts,
  totalCards,
  validateRulesDsl,
  type DesignDiagnostic,
  type DesignDiagnostics,
  type GameState,
  type RulesDsl,
} from '@hcg/shared';
import { createRng } from '../engine/deck.js';
import { createMatch, startNextHand } from '../engine/state.js';
import { generateLegalMoves } from '../engine/legal-moves.js';
import { applyMove } from '../engine/apply-move.js';
import { applyHandScoring } from '../engine/scoring.js';

/**
 * Safety cap on moves per hand. A 52-card hand is ~52 plays plus bids and a
 * trump selection; anything past this is a phase chain that never reaches
 * SCORING, which is a bug in the draft rather than a long game.
 */
const MAX_MOVES_PER_HAND = 4000;

/**
 * How many hands the smoke test plays. One hand proves dealing, bidding and
 * trick play; a second proves the deal *rotates* — a `schedule` deal whose
 * second entry is wrong, or a dealer rotation that redeals badly, only shows up
 * on hand two. Beyond that adds runtime without adding coverage.
 */
const HANDS_TO_SIMULATE = 2;

/**
 * Fixed seeds. The check has to be deterministic: a draft that passes on one
 * request and fails on the next would make the repair loop chase ghosts, and
 * would tell the author their game is broken only sometimes. Two seeds because
 * one shuffle can miss a void-suit path that the other hits.
 */
const SEEDS = [1, 20260828];

function error(message: string): DesignDiagnostic {
  return { severity: 'error', message };
}

function warning(message: string): DesignDiagnostic {
  return { severity: 'warning', message };
}

/**
 * Structural validation, then playability, then a pass of advisory checks.
 *
 * Ordered because they depend on each other: there is no point dealing a
 * document that failed `validateRulesDsl`, and no point warning about a
 * scoring field on a game that deadlocks in bidding. Each stage returns early
 * on failure so the author is shown the *first* thing wrong rather than a wall
 * of consequences.
 */
export function validateDraft(rawRules: unknown, strategy: string): DesignDiagnostics {
  const structural = validateRulesDsl(rawRules);
  if (!structural.valid) {
    return {
      valid: false,
      playable: false,
      diagnostics: structural.errors.map(error),
    };
  }

  const rules = rawRules as RulesDsl;
  const diagnostics: DesignDiagnostic[] = [];

  // strategy.md is not optional: `PluginManager.validateContent` refuses an
  // empty one, so a draft missing it could never be published.
  if (!strategy.trim()) {
    diagnostics.push(error('strategy.md is empty — the AI seats would have no guidance to play with'));
  }

  const playFailures = simulate(rules);
  diagnostics.push(...playFailures.map(error));
  const playable = playFailures.length === 0;

  if (playable) diagnostics.push(...advisoryChecks(rules, strategy));

  return {
    valid: !diagnostics.some((d) => d.severity === 'error'),
    playable,
    diagnostics,
  };
}

/**
 * Deals and plays the draft at every table size it claims to support.
 * Returns one message per failure, phrased as something the model can act on —
 * these strings go straight back into the repair prompt, so "no legal move in
 * phase X at seat Y" is worth far more than "simulation failed".
 */
function simulate(rules: RulesDsl): string[] {
  const failures: string[] = [];

  for (const playerCount of supportedPlayerCounts(rules)) {
    for (const seed of SEEDS) {
      try {
        playMatch(rules, playerCount, seed);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        failures.push(`With ${playerCount} players, a match could not be played: ${detail}`);
        // One failing seed per table size is enough to report. Trying the
        // second only produces the same message twice.
        break;
      }
    }
  }

  return failures;
}

function playMatch(rules: RulesDsl, playerCount: number, seed: number): void {
  const rng = createRng(seed);
  let state: GameState = createMatch({
    rules,
    // The draft has no id yet — the server assigns one only on publish — and
    // this string only ever appears in an error message.
    gameId: 'draft',
    matchId: `draft-${playerCount}-${seed}`,
    playerCount,
    dealerSeat: 0,
    playerNames: Array.from({ length: playerCount }, (_, i) => `P${i}`),
    aiSeats: new Set(),
    rng,
  });

  const hands = Math.min(HANDS_TO_SIMULATE, handLimit(rules));
  for (let hand = 0; hand < hands; hand++) {
    if (hand > 0) state = startNextHand(rules, state, rng);
    state = playHand(rules, state);
    state = applyHandScoring(rules, state);
  }
}

/** Drives one hand to its SCORING phase, always taking the first legal move. */
function playHand(rules: RulesDsl, initial: GameState): GameState {
  let state = initial;

  for (let i = 0; i < MAX_MOVES_PER_HAND; i++) {
    const phase = rules.phases.find((p) => p.name === state.phase);
    // `validateRulesDsl` checks that every `next` names a real phase, so this
    // should be unreachable — but the simulation is the last line of defence
    // and a crash here would surface as a 500 rather than a diagnostic.
    if (!phase) throw new Error(`reached undeclared phase "${state.phase}"`);
    if (phase.kind === 'SCORING') return state;

    const moves = generateLegalMoves(rules, state);
    if (moves.length === 0) {
      throw new Error(
        `no legal move exists in phase "${state.phase}" (kind ${phase.kind}) for seat ${state.turnSeat} — the hand cannot continue`,
      );
    }
    state = applyMove(rules, state, moves[0]!.id);
  }

  throw new Error(
    `the hand never reached a SCORING phase after ${MAX_MOVES_PER_HAND} moves — the phase chain probably loops`,
  );
}

/**
 * Things that play fine but are probably not what the author meant. Warnings,
 * never errors: each one is a judgement call, and blocking a publish on a
 * judgement call would make the designer argue with an author who knows what
 * they want.
 */
function advisoryChecks(rules: RulesDsl, strategy: string): DesignDiagnostic[] {
  const notes: DesignDiagnostic[] = [];
  const { scoring, deck, bidding, trump } = rules;

  if (scoring.maxHands === undefined && scoring.targetScore === undefined) {
    notes.push(
      warning(
        'scoring declares neither maxHands nor targetScore, so a match is a single hand. Set maxHands if the game should run several.',
      ),
    );
  }

  if (scoring.contractBasis === 'points' && Object.keys(deck.pointValues).length === 0 && !deck.suitPointValues && !deck.cardPointValues) {
    notes.push(
      warning(
        'scoring.contractBasis is "points" but no card carries any point value, so every hand scores zero. Set deck.pointValues, or use contractBasis "tricks".',
      ),
    );
  }

  if (scoring.contractBasis === 'tricks' && Object.keys(deck.pointValues).length > 0) {
    notes.push(
      warning(
        'deck.pointValues assigns card points but scoring.contractBasis is "tricks", so those values are never counted. One of the two is probably wrong.',
      ),
    );
  }

  if (bidding?.enabled && !rules.phases.some((p) => p.kind === 'BIDDING')) {
    notes.push(warning('bidding is enabled but no phase has kind "BIDDING", so no bid is ever taken.'));
  }

  if (bidding?.determines.includes('trump-suit') && trump.mode !== 'bid-selected') {
    notes.push(
      warning(
        `bidding.determines includes "trump-suit" but trump.mode is "${trump.mode}", so the winning bid does not actually choose trump.`,
      ),
    );
  }

  if (scoring.bags && scoring.formula?.kind !== 'bid-multiplier') {
    notes.push(warning('scoring.bags only has an effect with the "bid-multiplier" formula; it is ignored here.'));
  }

  if (scoring.moonShot && scoring.formula?.kind !== 'penalty-points') {
    notes.push(warning('scoring.moonShot only has an effect with the "penalty-points" formula; it is ignored here.'));
  }

  if (scoring.formula?.kind === 'penalty-points' && !scoring.lowerIsBetter) {
    notes.push(
      warning(
        'the "penalty-points" formula scores captured points as penalties, but lowerIsBetter is not set — so the player collecting the most penalties would win.',
      ),
    );
  }

  // A kitty-turnup with no kitty is caught by the simulation; a kitty that
  // exists but is never used is not, and usually means a deal was miscounted.
  for (const count of supportedPlayerCounts(rules)) {
    const { handSize, kittySize } = resolveDeal(rules, count, 1);
    if (handSize <= 0) {
      notes.push(warning(`at ${count} players each seat is dealt ${handSize} cards.`));
    }
    if (kittySize > 0 && trump.mode !== 'kitty-turnup') {
      notes.push(
        warning(
          `at ${count} players, ${kittySize} of the ${totalCards(rules)} cards are left undealt and never used. That is fine if intended.`,
        ),
      );
    }
  }

  // The strategy guide is what the AI seats actually play from, so a token
  // one is a real defect in the plugin even though it publishes fine.
  const words = strategy.trim().split(/\s+/).filter(Boolean).length;
  if (words > 0 && words < 120) {
    notes.push(
      warning(
        `strategy.md is only ${words} words. It is injected into the AI's system prompt as its entire guidance, so a thin guide means weak bots.`,
      ),
    );
  }

  return notes;
}
