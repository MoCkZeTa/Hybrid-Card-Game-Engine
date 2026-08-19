import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HIDDEN_CARD, HIDDEN_STATUS } from '@hcg/shared';
import { PluginManager } from '../plugin/plugin-manager.js';
import { InMemoryPluginRepository } from '../plugin/plugin-repository.js';
import { createRng } from '../engine/deck.js';
import { createMatch } from '../engine/state.js';
import { maskGameState } from './fog-of-war.js';

const gamesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'games');

async function loadPlugins() {
  return PluginManager.loadAll(gamesRoot, new InMemoryPluginRepository());
}

describe('fog of war', () => {
  it('reveals only the viewer\'s own hand; opponents are masked to HIDDEN placeholders of correct length', async () => {
    const plugins = await loadPlugins();
    const rules = plugins.get('callbreak').rules;
    const state = createMatch({
      rules,
      gameId: 'callbreak',
      matchId: 'm1',
      playerCount: 4,
      dealerSeat: 0,
      playerNames: ['A', 'B', 'C', 'D'],
      aiSeats: new Set([1, 2, 3]),
      rng: createRng(3),
    });

    const masked = maskGameState(rules, state, 0);
    expect(masked.players[0]!.hand).toEqual(state.players[0]!.hand);
    for (const seat of [1, 2, 3]) {
      expect(masked.players[seat]!.hand.every((c) => c === HIDDEN_CARD)).toBe(true);
      expect(masked.players[seat]!.hand).toHaveLength(state.players[seat]!.hand.length);
      expect(masked.players[seat]!.handCount).toBe(state.players[seat]!.hand.length);
    }
  });

  it('29: caps every hand to biddingHandSize during DEALING/BIDDING/TRUMP_SELECTION, reveals the rest once PLAYING starts', async () => {
    const plugins = await loadPlugins();
    const rules = plugins.get('29').rules;
    const state = createMatch({
      rules,
      gameId: '29',
      matchId: 'm1b',
      playerCount: 4,
      dealerSeat: 0,
      playerNames: ['A', 'B', 'C', 'D'],
      aiSeats: new Set([1, 2, 3]),
      rng: createRng(3),
    });
    expect(state.phase).toBe('BIDDING');
    expect(state.players[0]!.hand).toHaveLength(8); // dealt in full internally

    const masked = maskGameState(rules, state, 0);
    expect(masked.players[0]!.hand).toEqual(state.players[0]!.hand.slice(0, 4));
    expect(masked.players[0]!.handCount).toBe(4);
    for (const seat of [1, 2, 3]) {
      expect(masked.players[seat]!.hand).toHaveLength(4);
      expect(masked.players[seat]!.hand.every((c) => c === HIDDEN_CARD)).toBe(true);
      expect(masked.players[seat]!.handCount).toBe(4);
    }

    const playing = { ...state, phase: 'PLAYING' as const };
    const maskedPlaying = maskGameState(rules, playing, 0);
    expect(maskedPlaying.players[0]!.hand).toEqual(state.players[0]!.hand);
    expect(maskedPlaying.players[1]!.handCount).toBe(8);
  });

  it('hides the concealed trump suit from non-declarer viewers until revealed', async () => {
    const plugins = await loadPlugins();
    const rules = plugins.get('29').rules;
    // Force a known trump by fixing state directly rather than playing bidding out.
    const base = createMatch({
      rules,
      gameId: '29',
      matchId: 'm2',
      playerCount: 4,
      dealerSeat: 0,
      playerNames: ['A', 'B', 'C', 'D'],
      aiSeats: new Set(),
      rng: createRng(4),
    });
    const state = { ...base, declarerSeat: 0, trumpSuit: 'S' as const, trumpRevealed: false };

    const asDeclarer = maskGameState(rules, state, 0);
    expect(asDeclarer.trumpSuit).toBe('S'); // declarer fixed it, already knows

    const asOpponent = maskGameState(rules, state, 1);
    expect(asOpponent.trumpSuit).toBe(HIDDEN_STATUS);

    const asSpectator = maskGameState(rules, state, 'SPECTATOR');
    expect(asSpectator.trumpSuit).toBe(HIDDEN_STATUS);

    const revealed = { ...state, trumpRevealed: true };
    expect(maskGameState(rules, revealed, 1).trumpSuit).toBe('S');
  });

  it('only populates legalMoves for the seat whose turn it currently is', async () => {
    const plugins = await loadPlugins();
    const rules = plugins.get('callbreak').rules;
    const state = createMatch({
      rules,
      gameId: 'callbreak',
      matchId: 'm3',
      playerCount: 4,
      dealerSeat: 0,
      playerNames: ['A', 'B', 'C', 'D'],
      aiSeats: new Set(),
      rng: createRng(6),
    });

    const active = maskGameState(rules, state, state.turnSeat);
    expect(active.legalMoves.length).toBeGreaterThan(0);

    const idleSeat = (state.turnSeat + 1) % 4;
    const idle = maskGameState(rules, state, idleSeat);
    expect(idle.legalMoves).toHaveLength(0);

    const spectator = maskGameState(rules, state, 'SPECTATOR');
    expect(spectator.legalMoves).toHaveLength(0);
  });

  it('never exposes kitty contents, only its count', async () => {
    const plugins = await loadPlugins();
    const rules = plugins.get('29').rules;
    const state = createMatch({
      rules,
      gameId: '29',
      matchId: 'm4',
      playerCount: 4,
      dealerSeat: 0,
      playerNames: ['A', 'B', 'C', 'D'],
      aiSeats: new Set(),
      rng: createRng(8),
    });
    const masked = maskGameState(rules, state, 0) as unknown as Record<string, unknown>;
    expect(masked.kitty).toBeUndefined();
    expect((masked as { kittyCount: number }).kittyCount).toBe(state.kitty.length);
  });
});
