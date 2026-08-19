/**
 * End-to-end playthroughs driving the engine purely through
 * generateLegalMoves + applyMove — exactly the loop the WebSocket server and
 * AI pipeline will use. Always selects legal_moves[0] (mirrors the PRD 6
 * deterministic-fallback rule), so these tests exercise the full bidding ->
 * trump/selection -> playing -> scoring pipeline without needing an LLM.
 */

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginManager } from '../plugin/plugin-manager.js';
import { InMemoryPluginRepository } from '../plugin/plugin-repository.js';
import { createRng } from './deck.js';
import { createMatch } from './state.js';
import { generateLegalMoves } from './legal-moves.js';
import { applyMove, IllegalMoveError } from './apply-move.js';
import { applyHandScoring } from './scoring.js';
import type { GameState, RulesDsl } from '@hcg/shared';

const gamesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'games');

async function loadPlugins() {
  return PluginManager.loadAll(gamesRoot, new InMemoryPluginRepository());
}

/** Drives the engine deterministically (always legal_moves[0]) until PLAYING/SCORING is reached or a safety cap trips. */
function playUntil(rules: RulesDsl, initial: GameState, targetPhaseKind: 'PLAYING' | 'SCORING'): GameState {
  let state = initial;
  for (let i = 0; i < 500; i++) {
    const kind = rules.phases.find((p) => p.name === state.phase)!.kind;
    if (kind === targetPhaseKind) return state;
    const moves = generateLegalMoves(rules, state);
    if (moves.length === 0) throw new Error(`No legal moves in phase "${state.phase}" (seat ${state.turnSeat})`);
    state = applyMove(rules, state, moves[0]!.id);
  }
  throw new Error('playUntil exceeded safety cap — likely an infinite loop in phase transitions');
}

describe('29 full hand playthrough', () => {
  it('runs bidding -> trump selection -> playing -> scoring without error', async () => {
    const plugins = await loadPlugins();
    const rules = plugins.get('29').rules;
    let state = createMatch({
      rules,
      gameId: '29',
      matchId: 'm-29-1',
      playerCount: 4,
      dealerSeat: 0,
      playerNames: ['A', 'B', 'C', 'D'],
      aiSeats: new Set([1, 2, 3]),
      rng: createRng(5),
    });

    state = playUntil(rules, state, 'PLAYING');
    expect(state.declarerSeat).not.toBeNull();
    expect(state.trumpSuit).not.toBeNull();
    // Trump was chosen via the hidden path — never auto-revealed at selection time.
    expect(state.trumpRevealed).toBe(false);

    state = playUntil(rules, state, 'SCORING');
    expect(state.players.every((p) => p.hand.length === 0)).toBe(true);
    expect(state.players.reduce((sum, p) => sum + p.tricksWon, 0)).toBe(8); // one trick per hand-card

    const scored = applyHandScoring(rules, state);
    const totalAbsDelta = Object.values(scored.teamScores).reduce((s, v) => s + Math.abs(v), 0);
    expect(totalAbsDelta).toBeGreaterThan(0);
  });

  it('rejects an out-of-set move id (PRD 5.2 invalid choice handling)', async () => {
    const plugins = await loadPlugins();
    const rules = plugins.get('29').rules;
    const state = createMatch({
      rules,
      gameId: '29',
      matchId: 'm-29-2',
      playerCount: 4,
      dealerSeat: 0,
      playerNames: ['A', 'B', 'C', 'D'],
      aiSeats: new Set(),
      rng: createRng(9),
    });
    expect(() => applyMove(rules, state, 'not-a-real-move')).toThrow(IllegalMoveError);
  });
});

describe('Callbreak full hand playthrough', () => {
  it('runs bidding -> playing -> scoring, every seat bids once, no passing', async () => {
    const plugins = await loadPlugins();
    const rules = plugins.get('callbreak').rules;
    let state = createMatch({
      rules,
      gameId: 'callbreak',
      matchId: 'm-cb-1',
      playerCount: 4,
      dealerSeat: 0,
      playerNames: ['A', 'B', 'C', 'D'],
      aiSeats: new Set([1, 2, 3]),
      rng: createRng(11),
    });

    state = playUntil(rules, state, 'PLAYING');
    expect(state.players.every((p) => p.bid !== null && p.bid! >= 1)).toBe(true);
    expect(state.declarerSeat).toBeNull(); // solo topology: no single declarer

    state = playUntil(rules, state, 'SCORING');
    expect(state.players.reduce((sum, p) => sum + p.tricksWon, 0)).toBe(13);

    const scored = applyHandScoring(rules, state);
    for (const player of scored.players) {
      const key = `seat-${player.seat}`;
      expect(scored.teamScores[key]).toBeDefined();
    }
  });

  it('enforces must-follow-suit once a lead suit is established', async () => {
    const plugins = await loadPlugins();
    const rules = plugins.get('callbreak').rules;
    let state = createMatch({
      rules,
      gameId: 'callbreak',
      matchId: 'm-cb-2',
      playerCount: 4,
      dealerSeat: 0,
      playerNames: ['A', 'B', 'C', 'D'],
      aiSeats: new Set([1, 2, 3]),
      rng: createRng(13),
    });
    state = playUntil(rules, state, 'PLAYING');

    // Seat leads; capture the led suit, then check the next player's options.
    const leadMoves = generateLegalMoves(rules, state);
    state = applyMove(rules, state, leadMoves[0]!.id);
    expect(state.leadSuit).not.toBeNull();

    const followerHand = state.players[state.turnSeat]!.hand;
    const hasLeadSuit = followerHand.some((c) => c.endsWith(state.leadSuit!));
    const followerMoves = generateLegalMoves(rules, state);
    if (hasLeadSuit) {
      expect(followerMoves.every((m) => (m.actions[0] as { card: string }).card.endsWith(state.leadSuit!))).toBe(true);
    } else {
      expect(followerMoves.length).toBe(followerHand.length);
    }
  });
});
