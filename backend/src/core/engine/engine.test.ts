import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginManager } from '../plugin/plugin-manager.js';
import { InMemoryPluginRepository } from '../plugin/plugin-repository.js';
import { buildDeck, createRng, deal, shuffle } from './deck.js';
import { createMatch, teamKeyForSeat, nextPhase } from './state.js';
import { resolveTrick, trickPointValue } from './trick.js';
import { resolveDeal, supportedPlayerCounts, type TrickCard } from '@hcg/shared';

const gamesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'games');

async function loadPlugins() {
  return PluginManager.loadAll(gamesRoot, new InMemoryPluginRepository());
}

describe('deck', () => {
  it('builds a full deck matching suits x ranks for 29', async () => {
    const plugins = await loadPlugins();
    const rules = plugins.get('29').rules;
    const deck = buildDeck(rules);
    expect(deck.length).toBe(32);
    expect(new Set(deck).size).toBe(32); // no duplicates
  });

  it('deals exact hand sizes with no leftover or overlap for Callbreak (52 cards, 0 kitty)', async () => {
    const plugins = await loadPlugins();
    const rules = plugins.get('callbreak').rules;
    const { hands, kitty } = deal(rules, 4, createRng(42));
    expect(hands).toHaveLength(4);
    for (const hand of hands) expect(hand).toHaveLength(13);
    expect(kitty).toHaveLength(0);
    const allCards = hands.flat();
    expect(new Set(allCards).size).toBe(52);
  });

  it('deals correctly at every table size for an even-split game (3-6), remainder to the kitty', async () => {
    // A synthetic even-split ruleset — not any shipped plugin's actual
    // supported player range — purely to exercise resolveDeal/deal's
    // remainder-to-kitty behaviour across table sizes.
    const rules = {
      gameId: 'even-split-test',
      displayName: 'Even Split (test)',
      version: '1.0.0',
      players: { min: 3, max: 6, defaultCount: 4, topology: 'solo' },
      deck: {
        suits: ['S', 'H', 'D', 'C'],
        ranks: ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'],
        deal: { mode: 'even-split' },
        rankOrder: ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'],
        pointValues: {},
      },
      trump: { mode: 'static', staticSuit: 'S' },
      bidding: { enabled: true, minBid: 1, maxBid: 13, allowPass: false, determines: ['trick-quota'] },
      phases: [
        { name: 'DEALING', kind: 'DEALING', next: 'BIDDING' },
        { name: 'BIDDING', kind: 'BIDDING', next: 'PLAYING' },
        { name: 'PLAYING', kind: 'PLAYING', next: 'SCORING' },
        { name: 'SCORING', kind: 'SCORING', next: null },
      ],
      trickRules: { mustFollowSuit: true, mustTrumpIfVoid: false, freeDiscardIfVoidAndNoTrump: true, mustOvertrumpIfPossible: false },
      scoring: { contractBasis: 'tricks' },
    } as const;
    expect(supportedPlayerCounts(rules)).toEqual([3, 4, 5, 6]);

    // 52 cards: 3->17r1, 4->13r0, 5->10r2, 6->8r4
    const expected: Record<number, { hand: number; kitty: number }> = {
      3: { hand: 17, kitty: 1 },
      4: { hand: 13, kitty: 0 },
      5: { hand: 10, kitty: 2 },
      6: { hand: 8, kitty: 4 },
    };

    for (const count of supportedPlayerCounts(rules)) {
      const { hands, kitty } = deal(rules, count, createRng(count));
      expect(hands).toHaveLength(count);
      for (const hand of hands) expect(hand).toHaveLength(expected[count]!.hand);
      expect(kitty).toHaveLength(expected[count]!.kitty);
      // Every card accounted for exactly once.
      expect(new Set([...hands.flat(), ...kitty]).size).toBe(52);
    }
  });

  it('29 stays fixed at 4 players', async () => {
    const plugins = await loadPlugins();
    const rules = plugins.get('29').rules;
    expect(supportedPlayerCounts(rules)).toEqual([4]);
    expect(resolveDeal(rules, 4)).toEqual({ handSize: 8, kittySize: 0 });
  });

  it('shuffle is deterministic for a fixed seed', () => {
    const a = shuffle([1, 2, 3, 4, 5], createRng(7));
    const b = shuffle([1, 2, 3, 4, 5], createRng(7));
    expect(a).toEqual(b);
  });
});

describe('state', () => {
  it('assigns fixed-pairs team keys for 29 (seats 0,2 vs 1,3)', async () => {
    const plugins = await loadPlugins();
    const rules = plugins.get('29').rules;
    expect(teamKeyForSeat(rules, 0, 4)).toBe(teamKeyForSeat(rules, 2, 4));
    expect(teamKeyForSeat(rules, 1, 4)).toBe(teamKeyForSeat(rules, 3, 4));
    expect(teamKeyForSeat(rules, 0, 4)).not.toBe(teamKeyForSeat(rules, 1, 4));
  });

  it('assigns a distinct team key per seat for solo Callbreak', async () => {
    const plugins = await loadPlugins();
    const rules = plugins.get('callbreak').rules;
    const keys = [0, 1, 2, 3].map((seat) => teamKeyForSeat(rules, seat, 4));
    expect(new Set(keys).size).toBe(4);
  });

  it('createMatch deals hands, sets first phase, and starts trump hidden for 29', async () => {
    const plugins = await loadPlugins();
    const rules = plugins.get('29').rules;
    const state = createMatch({
      rules,
      gameId: '29',
      matchId: 'm1',
      playerCount: 4,
      dealerSeat: 0,
      playerNames: ['A', 'B', 'C', 'D'],
      aiSeats: new Set([1, 2, 3]),
      rng: createRng(1),
    });
    expect(state.phase).toBe('BIDDING'); // DEALING is instantaneous; createMatch skips straight past it
    expect(state.players[0]!.hand).toHaveLength(8);
    expect(state.trumpRevealed).toBe(false);
    expect(state.trumpSuit).toBeNull();
    expect(state.turnSeat).toBe(1); // left of dealer
  });

  it('createMatch fixes static trump immediately for Callbreak', async () => {
    const plugins = await loadPlugins();
    const rules = plugins.get('callbreak').rules;
    const state = createMatch({
      rules,
      gameId: 'callbreak',
      matchId: 'm2',
      playerCount: 4,
      dealerSeat: 0,
      playerNames: ['A', 'B', 'C', 'D'],
      aiSeats: new Set(),
      rng: createRng(2),
    });
    expect(state.trumpSuit).toBe('S');
    expect(state.trumpRevealed).toBe(true);
  });

  it('walks the declared phase chain to its terminal phase', async () => {
    const plugins = await loadPlugins();
    const rules = plugins.get('callbreak').rules;
    let phase: string | null = 'DEALING';
    const seen: string[] = [];
    while (phase !== null) {
      seen.push(phase);
      phase = nextPhase(rules, phase);
    }
    expect(seen).toEqual(['DEALING', 'BIDDING', 'PLAYING', 'SCORING']);
  });
});

describe('trick resolution', () => {
  it('highest card of the led suit wins when trump is not revealed', async () => {
    const plugins = await loadPlugins();
    const rules = plugins.get('29').rules;
    const trick: TrickCard[] = [
      { seat: 0, card: '7H' },
      { seat: 1, card: 'AH' }, // highest in led suit per 29 rank order
      { seat: 2, card: 'JS' }, // off-suit, trump hidden so cannot win
      { seat: 3, card: '8H' },
    ];
    const winner = resolveTrick(rules, trick, 'H', null);
    expect(winner).toBe(1);
  });

  it('a trump card beats every non-trump card once revealed', async () => {
    const plugins = await loadPlugins();
    const rules = plugins.get('29').rules;
    const trick: TrickCard[] = [
      { seat: 0, card: 'AH' }, // strongest non-trump
      { seat: 1, card: '7S' }, // weakest trump, still wins once revealed
      { seat: 2, card: 'TH' },
      { seat: 3, card: '9H' },
    ];
    const winner = resolveTrick(rules, trick, 'H', 'S');
    expect(winner).toBe(1);
  });

  it('computes correct point value for a trick in 29', async () => {
    const plugins = await loadPlugins();
    const rules = plugins.get('29').rules;
    const trick: TrickCard[] = [
      { seat: 0, card: 'JH' }, // 3
      { seat: 1, card: '9H' }, // 2
      { seat: 2, card: '7S' }, // 0
      { seat: 3, card: 'AH' }, // 1
    ];
    expect(trickPointValue(rules, trick)).toBe(6);
  });

  it('Callbreak tricks carry zero point value (pure trick-count game)', async () => {
    const plugins = await loadPlugins();
    const rules = plugins.get('callbreak').rules;
    const trick: TrickCard[] = [
      { seat: 0, card: 'AS' },
      { seat: 1, card: 'KS' },
      { seat: 2, card: 'QS' },
      { seat: 3, card: 'JS' },
    ];
    expect(trickPointValue(rules, trick)).toBe(0);
  });
});
