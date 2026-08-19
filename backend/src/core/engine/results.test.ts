/**
 * Round/game result construction and the multi-hand deal.
 *
 * The point of these tests is that the result table is derived entirely from
 * the rules DSL — the same code produces a correct table for a solo
 * tricks-contract game (Callbreak) and a partnership points-contract one
 * (29), and would for an imported plugin nobody has written yet.
 */

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GameState, RulesDsl } from '@hcg/shared';
import { PluginManager } from '../plugin/plugin-manager.js';
import { InMemoryPluginRepository } from '../plugin/plugin-repository.js';
import { createRng } from './deck.js';
import { createMatch, startNextHand } from './state.js';
import { generateLegalMoves } from './legal-moves.js';
import { applyMove } from './apply-move.js';
import { applyHandScoring, matchEndReason } from './scoring.js';

const gamesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'games');

function playToScoring(rules: RulesDsl, initial: GameState): GameState {
  let state = initial;
  for (let i = 0; i < 500; i++) {
    if (rules.phases.find((p) => p.name === state.phase)!.kind === 'SCORING') return state;
    state = applyMove(rules, state, generateLegalMoves(rules, state)[0]!.id);
  }
  throw new Error('never reached SCORING');
}

async function freshHand(gameId: string, seed: number) {
  const plugins = await PluginManager.loadAll(gamesRoot, new InMemoryPluginRepository());
  const rules = plugins.get(gameId).rules;
  const state = createMatch({
    rules,
    gameId,
    matchId: `m-${gameId}-${seed}`,
    playerCount: rules.players.defaultCount,
    dealerSeat: 0,
    playerNames: ['Ana', 'Ben', 'Cleo', 'Dev'],
    aiSeats: new Set([1, 2, 3]),
    rng: createRng(seed),
  });
  return { rules, state };
}

describe('round result (solo, tricks contract — Callbreak)', () => {
  it('reports one row per seat with bid, tricks made, delta and running total', async () => {
    const { rules, state } = await freshHand('callbreak', 21);
    const scored = applyHandScoring(rules, playToScoring(rules, state));
    const result = scored.lastResult!;

    expect(result.basis).toBe('tricks');
    expect(result.rows).toHaveLength(4);
    expect(result.rows.map((r) => r.label).sort()).toEqual(['Ana', 'Ben', 'Cleo', 'Dev']);

    for (const row of result.rows) {
      expect(row.seats).toHaveLength(1); // solo: one seat per competitor
      expect(row.bid).not.toBeNull();
      expect(row.contract).toBe(row.made >= row.bid! ? 'MADE' : 'MISSED');
      // Deltas are diffed from the real scores, so they must reconstruct the totals.
      expect(row.total).toBeCloseTo(row.delta, 5);
    }

    // Every trick in the hand is accounted for across the rows.
    expect(result.rows.reduce((sum, r) => sum + r.made, 0)).toBe(13);
  });

  it('sorts rows best-first and marks the round winner by this hand\'s gain', async () => {
    const { rules, state } = await freshHand('callbreak', 34);
    const result = applyHandScoring(rules, playToScoring(rules, state)).lastResult!;

    const totals = result.rows.map((r) => r.total);
    expect([...totals].sort((a, b) => b - a)).toEqual(totals);
    expect(result.rows[0]!.rank).toBe(1);

    const bestDelta = Math.max(...result.rows.map((r) => r.delta));
    for (const key of result.roundWinnerKeys) {
      expect(result.rows.find((r) => r.key === key)!.delta).toBe(bestDelta);
    }
  });

  it('scopes the first hand as ROUND and the last as GAME', async () => {
    const { rules, state } = await freshHand('callbreak', 47);
    expect(rules.scoring.maxHands).toBe(5);

    let current = applyHandScoring(rules, playToScoring(rules, state));
    expect(current.lastResult!.scope).toBe('ROUND');
    expect(current.lastResult!.totalHands).toBe(5);
    expect(current.lastResult!.endReason).toBeNull();

    for (let hand = 2; hand <= 5; hand++) {
      current = applyHandScoring(rules, playToScoring(rules, startNextHand(rules, current, createRng(hand))));
      expect(current.lastResult!.handNumber).toBe(hand);
    }

    expect(current.lastResult!.scope).toBe('GAME');
    expect(current.lastResult!.endReason).toBe('hand-limit');
    expect(current.lastResult!.winnerKeys.length).toBeGreaterThan(0);
  });
});

describe('round result (partnership, points contract — 29)', () => {
  it('groups seats into teams and scores only the declaring side, one game point', async () => {
    const { rules, state } = await freshHand('29', 8);
    const scored = applyHandScoring(rules, playToScoring(rules, state));
    const result = scored.lastResult!;

    expect(result.basis).toBe('points');
    expect(result.rows).toHaveLength(2);
    for (const row of result.rows) {
      expect(row.seats).toHaveLength(2);
      expect(row.playerNames).toHaveLength(2);
      expect(row.label).toMatch(/^Team [12]$/);
    }

    const declarer = result.rows.find((r) => r.isDeclarer)!;
    const defender = result.rows.find((r) => !r.isDeclarer)!;

    // Only the declaring side contracted anything: their row shows that one
    // seat's bid (not both partners' bids added together), and the defenders
    // show no bid at all.
    const declarerSeatBid = scored.players[scored.declarerSeat!]!.bid;
    expect(declarer.bid).toBe(declarerSeatBid);
    expect(defender.bid).toBeNull();

    // Exactly one side makes its contract — defending succeeds when the
    // declaring side falls short.
    expect(declarer.contract).not.toBe(defender.contract);
    expect(declarer.contract).toBe(declarer.delta > 0 ? 'MADE' : 'MISSED');

    // 29 plays for a single game point however high the bid was, and a side
    // that did not win the auction does not move at all.
    expect(Math.abs(declarer.delta)).toBe(1);
    expect(defender.delta).toBe(0);
  });
});

describe('match end conditions', () => {
  it('ends on a target score before the hand limit is reached', async () => {
    const { rules } = await freshHand('29', 3);
    expect(matchEndReason(rules, 1, { 'team-0': 6, 'team-1': 0 })).toBe('target-score');
    expect(matchEndReason(rules, 1, { 'team-0': 3, 'team-1': 0 })).toBeNull();
  });

  it('plays a single hand when a plugin declares neither maxHands nor targetScore', async () => {
    const { rules } = await freshHand('callbreak', 3);
    const oneShot: RulesDsl = { ...rules, scoring: { contractBasis: 'tricks' } };
    expect(matchEndReason(oneShot, 1, { 'seat-0': 1 })).toBe('hand-limit');
  });
});

describe('startNextHand', () => {
  it('re-deals and resets per-hand state while carrying the match score forward', async () => {
    const { rules, state } = await freshHand('callbreak', 55);
    const scored = applyHandScoring(rules, playToScoring(rules, state));
    const next = startNextHand(rules, scored, createRng(56));

    expect(next.handNumber).toBe(2);
    expect(next.teamScores).toEqual(scored.teamScores); // carried over
    expect(next.lastResult).toBeNull(); // popup dismissed by the new deal
    expect(next.dealerSeat).toBe((scored.dealerSeat + 1) % 4); // dealer moves left
    expect(next.turnSeat).toBe((next.dealerSeat + 1) % 4);

    for (const player of next.players) {
      expect(player.hand).toHaveLength(13);
      expect(player.tricksWon).toBe(0);
      expect(player.bid).toBeNull();
    }
    expect(next.currentTrick).toEqual([]);
    expect(next.lastTrick).toBeNull();
    expect(Object.values(next.handPoints).every((v) => v === 0)).toBe(true);
    // Names and AI assignment survive the re-deal.
    expect(next.players.map((p) => p.name)).toEqual(['Ana', 'Ben', 'Cleo', 'Dev']);
    expect(next.players.map((p) => p.isAI)).toEqual([false, true, true, true]);
  });
});
