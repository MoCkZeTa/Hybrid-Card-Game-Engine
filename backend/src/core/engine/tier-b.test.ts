/**
 * The DSL primitives added for the Tier B games — trump modes that resolve
 * somewhere other than an auction, non-rectangular decks, per-hand deal
 * schedules, locked lead suits, and the scoring formula table.
 *
 * Each test drives a real library plugin rather than a synthetic ruleset
 * wherever it can, so these double as proof that the shipped rules.json files
 * mean what their game is supposed to mean.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GameState, RulesDsl, SeatIndex } from '@hcg/shared';
import { cardPointValue, parseCard, resolveDeal, totalCards } from '@hcg/shared';
import { buildDeck, createRng } from './deck.js';
import { createMatch, startNextHand } from './state.js';
import { generateLegalMoves } from './legal-moves.js';
import { applyMove } from './apply-move.js';
import { applyHandScoring } from './scoring.js';
import { maskGameState } from '../obfuscation/fog-of-war.js';

const libraryRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', '..', 'game-plugins',
);

function loadRules(gameId: string): RulesDsl {
  return JSON.parse(readFileSync(path.join(libraryRoot, gameId, 'rules.json'), 'utf-8')) as RulesDsl;
}

function newMatch(
  rules: RulesDsl,
  seed = 5,
  playerCount = rules.players.defaultCount,
  gameId = rules.displayName,
): GameState {
  return createMatch({
    rules,
    gameId,
    matchId: `t-${gameId}`,
    playerCount,
    dealerSeat: 0,
    playerNames: Array.from({ length: playerCount }, (_, i) => `P${i}`),
    aiSeats: new Set(),
    rng: createRng(seed),
  });
}

/** Rewrites per-seat hand outcomes so a scoring formula can be exercised directly. */
function withOutcome(
  state: GameState,
  outcomes: readonly { seat: SeatIndex; bid: number | null; tricksWon: number }[],
  handPoints: Record<string, number> = {},
): GameState {
  return {
    ...state,
    players: state.players.map((p) => {
      const o = outcomes.find((x) => x.seat === p.seat);
      return o ? { ...p, bid: o.bid, tricksWon: o.tricksWon } : p;
    }),
    handPoints: { ...state.handPoints, ...handPoints },
  };
}

// ---------------------------------------------------------------------------
// Deck
// ---------------------------------------------------------------------------

describe('deck.excludedCards', () => {
  it('builds 3-2-5 as a 30-card deck with no Seven of Diamonds or Clubs', () => {
    const rules = loadRules('325');
    const deck = buildDeck(rules);
    expect(deck).toHaveLength(30);
    expect(totalCards(rules)).toBe(30);
    expect(deck).not.toContain('7D');
    expect(deck).not.toContain('7C');
    expect(deck).toContain('7S');
    expect(deck).toContain('7H');
  });

  it('deals the whole 30-card deck to three players with nothing left over', () => {
    const rules = loadRules('325');
    const state = newMatch(rules);
    const dealt = state.players.flatMap((p) => p.hand);
    expect(dealt).toHaveLength(30);
    expect(new Set(dealt).size).toBe(30);
    expect(state.kitty).toHaveLength(0);
  });
});

describe('deck.deal.mode "schedule"', () => {
  const rules = loadRules('oh-hell');

  it('shrinks then grows the hand across the match', () => {
    expect(resolveDeal(rules, 4, 1).handSize).toBe(7);
    expect(resolveDeal(rules, 4, 4).handSize).toBe(4);
    expect(resolveDeal(rules, 4, 7).handSize).toBe(1);
    expect(resolveDeal(rules, 4, 13).handSize).toBe(7);
  });

  it('deals the scheduled size for the hand actually being played', () => {
    let state = newMatch(rules);
    for (const player of state.players) expect(player.hand).toHaveLength(7);

    state = startNextHand(rules, state, createRng(2));
    expect(state.handNumber).toBe(2);
    for (const player of state.players) expect(player.hand).toHaveLength(6);
  });

  it('leaves the undealt remainder as a kitty at every table size', () => {
    for (let n = rules.players.min; n <= rules.players.max; n++) {
      const { handSize, kittySize } = resolveDeal(rules, n, 1);
      expect(handSize * n + kittySize).toBe(52);
      expect(kittySize).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Trump modes
// ---------------------------------------------------------------------------

describe('trump.mode "none"', () => {
  const rules = loadRules('whist');

  it('starts and stays trumpless, and offers no trump selection', () => {
    const state = newMatch(rules);
    expect(state.trumpSuit).toBeNull();
    expect(state.trumpRevealed).toBe(true);
    expect(generateLegalMoves(rules, state).every((m) => m.actions[0]!.type === 'PLAY_CARD')).toBe(true);
  });

  it('never lets an off-suit card win a trick', () => {
    let state = newMatch(rules);
    const leadSuit = parseCard(state.players[state.turnSeat]!.hand[0]!).suit;
    for (let i = 0; i < 4; i++) {
      state = applyMove(rules, state, generateLegalMoves(rules, state)[0]!.id);
    }
    const winner = state.lastTrick!.find((t) => t.seat === state.turnSeat)!;
    expect(parseCard(winner.card).suit).toBe(leadSuit);
  });
});

describe('trump.mode "declared-by-lead"', () => {
  const rules = loadRules('court-piece');

  it('has no trump until the opening lead, then takes it from that card', () => {
    const state = newMatch(rules);
    expect(state.trumpSuit).toBeNull();
    expect(state.trumpRevealed).toBe(false);

    const opening = generateLegalMoves(rules, state)[0]!;
    const card = opening.actions[0]!.type === 'PLAY_CARD' ? opening.actions[0]!.card : null;
    const after = applyMove(rules, state, opening.id);

    expect(after.trumpSuit).toBe(parseCard(card!).suit);
    expect(after.trumpRevealed).toBe(true);
  });

  it('keeps the trump fixed for the rest of the hand, including later leads', () => {
    const opening = newMatch(rules);
    let state = applyMove(rules, opening, generateLegalMoves(rules, opening)[0]!.id);
    const fixed = state.trumpSuit;
    expect(fixed).not.toBeNull();

    let tricksSeen = 0;
    while (state.players.some((p) => p.hand.length > 0)) {
      const moves = generateLegalMoves(rules, state);
      if (moves.length === 0) break;
      const before = state.lastTrick;
      state = applyMove(rules, state, moves[0]!.id);
      if (state.lastTrick !== before) tricksSeen++;
      expect(state.trumpSuit).toBe(fixed);
    }
    // A later trick's opening lead must not re-declare trump, which is the
    // failure this guards against.
    expect(tricksSeen).toBeGreaterThan(1);
  });
});

describe('trump.mode "chooser"', () => {
  const rules = loadRules('325');

  it('gives the trump choice to the seat at the configured offset from the dealer', () => {
    const state = newMatch(rules);
    // 3-2-5's chooser is the dealer's right, which is offset 2 at a 3-seat table.
    expect(state.declarerSeat).toBe(2);
    expect(state.turnSeat).toBe(2);
    expect(state.phase).toBe('TRUMP_SELECTION');
    expect(generateLegalMoves(rules, state).map((m) => m.id).sort()).toEqual([
      'trump-C', 'trump-D', 'trump-H', 'trump-S',
    ]);
  });

  it('follows the dealer as it rotates between hands', () => {
    const first = newMatch(rules);
    const second = startNextHand(rules, first, createRng(9));
    expect(second.dealerSeat).toBe(1);
    expect(second.declarerSeat).toBe((1 + 2) % 3);
  });

  it('reveals the chosen suit openly and moves to play', () => {
    const state = newMatch(rules);
    const after = applyMove(rules, state, 'trump-H');
    expect(after.trumpSuit).toBe('H');
    expect(after.trumpRevealed).toBe(true);
    expect(after.phase).toBe('PLAYING');
  });
});

describe('trump.mode "kitty-turnup"', () => {
  it('takes trump from the first undealt card, face up from the start', () => {
    const rules = loadRules('oh-hell');
    const state = newMatch(rules);
    expect(state.trumpRevealed).toBe(true);
    expect(state.trumpSuit).toBe(parseCard(state.kitty[0]!).suit);
  });
});

// ---------------------------------------------------------------------------
// Trick rules
// ---------------------------------------------------------------------------

describe('trickRules.lockedLeadSuits', () => {
  const rules = loadRules('hearts');

  it('withholds Hearts from an opening lead until one has been played', () => {
    const state = newMatch(rules);
    expect(state.brokenSuits).toEqual([]);
    const leads = generateLegalMoves(rules, state);
    const heartLeads = leads.filter(
      (m) => m.actions[0]!.type === 'PLAY_CARD' && parseCard(m.actions[0]!.card).suit === 'H',
    );
    // The opener holds non-Hearts here, so every Heart lead must be withheld.
    expect(state.players[state.turnSeat]!.hand.some((c) => parseCard(c).suit !== 'H')).toBe(true);
    expect(heartLeads).toHaveLength(0);
  });

  it('unlocks the suit once a Heart is discarded off-lead', () => {
    const state = newMatch(rules);
    const broken: GameState = { ...state, brokenSuits: ['H'] };
    const leads = generateLegalMoves(rules, broken);
    const hearts = broken.players[broken.turnSeat]!.hand.filter((c) => parseCard(c).suit === 'H');
    const heartLeads = leads.filter(
      (m) => m.actions[0]!.type === 'PLAY_CARD' && parseCard(m.actions[0]!.card).suit === 'H',
    );
    expect(heartLeads).toHaveLength(hearts.length);
  });

  it('lets a seat holding nothing but Hearts lead one anyway', () => {
    const state = newMatch(rules);
    const onlyHearts: GameState = {
      ...state,
      players: state.players.map((p) =>
        p.seat === state.turnSeat ? { ...p, hand: ['2H', '5H', 'KH'] } : p,
      ),
    };
    expect(generateLegalMoves(rules, onlyHearts)).toHaveLength(3);
  });

  it('records a suit as broken when it is played', () => {
    const state = newMatch(rules);
    const forced: GameState = {
      ...state,
      players: state.players.map((p) =>
        p.seat === state.turnSeat ? { ...p, hand: ['2H'] } : p,
      ),
    };
    const after = applyMove(rules, forced, 'play-2H');
    expect(after.brokenSuits).toEqual(['H']);
  });
});

// ---------------------------------------------------------------------------
// Point tables
// ---------------------------------------------------------------------------

describe('deck point tables', () => {
  const rules = loadRules('hearts');

  it('scores every Heart at one and the Queen of Spades at thirteen', () => {
    expect(cardPointValue(rules.deck, '2H')).toBe(1);
    expect(cardPointValue(rules.deck, 'AH')).toBe(1);
    expect(cardPointValue(rules.deck, 'QS')).toBe(13);
    expect(cardPointValue(rules.deck, 'KS')).toBe(0);
    expect(cardPointValue(rules.deck, '7D')).toBe(0);
  });

  it('puts exactly 26 penalty points in the deck', () => {
    const total = buildDeck(rules).reduce((sum, c) => sum + cardPointValue(rules.deck, c), 0);
    expect(total).toBe(26);
  });
});

// ---------------------------------------------------------------------------
// Scoring formulas
// ---------------------------------------------------------------------------

describe('scoring formula "penalty-points" (Hearts)', () => {
  const rules = loadRules('hearts');

  it('adds captured penalties to the score, so the best hand scores nothing', () => {
    const state = withOutcome(newMatch(rules), [], {
      'seat-0': 0, 'seat-1': 13, 'seat-2': 8, 'seat-3': 5,
    });
    const scored = applyHandScoring(rules, state);
    expect(scored.teamScores).toEqual({ 'seat-0': 0, 'seat-1': 13, 'seat-2': 8, 'seat-3': 5 });
  });

  it('ranks the lowest total first and calls it the winner', () => {
    const state = withOutcome(newMatch(rules), [], {
      'seat-0': 0, 'seat-1': 13, 'seat-2': 8, 'seat-3': 5,
    });
    const result = applyHandScoring(rules, state).lastResult!;
    expect(result.rows[0]!.key).toBe('seat-0');
    expect(result.rows[0]!.rank).toBe(1);
    expect(result.winnerKeys).toEqual(['seat-0']);
    expect(result.roundWinnerKeys).toEqual(['seat-0']);
  });

  it('shows no contract, since nobody bid anything', () => {
    const state = withOutcome(newMatch(rules), [], { 'seat-0': 26 });
    const result = applyHandScoring(rules, state).lastResult!;
    for (const row of result.rows) {
      expect(row.bid).toBeNull();
      expect(row.contract).toBeNull();
    }
  });

  it('inverts the hand when one player shoots the moon', () => {
    const state = withOutcome(newMatch(rules), [], {
      'seat-0': 26, 'seat-1': 0, 'seat-2': 0, 'seat-3': 0,
    });
    const scored = applyHandScoring(rules, state);
    expect(scored.teamScores).toEqual({ 'seat-0': 0, 'seat-1': 26, 'seat-2': 26, 'seat-3': 26 });
  });

  it('does not treat an ordinary sweep of some points as a moon shot', () => {
    const state = withOutcome(newMatch(rules), [], {
      'seat-0': 25, 'seat-1': 1, 'seat-2': 0, 'seat-3': 0,
    });
    const scored = applyHandScoring(rules, state);
    expect(scored.teamScores['seat-0']).toBe(25);
    expect(scored.teamScores['seat-1']).toBe(1);
  });
});

describe('scoring formula "bid-multiplier" with bags and nil (Spades)', () => {
  const rules = loadRules('spades');

  it('pays ten a trick for a made contract and one for each overtrick', () => {
    // team-0 is seats 0 and 2: bid 3 + 3 = 6, took 5 + 4 = 9.
    const state = withOutcome(newMatch(rules), [
      { seat: 0, bid: 3, tricksWon: 5 },
      { seat: 2, bid: 3, tricksWon: 4 },
      { seat: 1, bid: 2, tricksWon: 2 },
      { seat: 3, bid: 2, tricksWon: 2 },
    ]);
    const scored = applyHandScoring(rules, state);
    expect(scored.teamScores['team-0']).toBe(63);
    expect(scored.bags['team-0']).toBe(3);
  });

  it('costs ten a trick for a missed contract, however narrow the miss', () => {
    const state = withOutcome(newMatch(rules), [
      { seat: 0, bid: 4, tricksWon: 3 },
      { seat: 2, bid: 4, tricksWon: 4 },
      { seat: 1, bid: 2, tricksWon: 3 },
      { seat: 3, bid: 3, tricksWon: 3 },
    ]);
    const scored = applyHandScoring(rules, state);
    expect(scored.teamScores['team-0']).toBe(-80);
    expect(scored.bags['team-0']).toBe(0);
  });

  it('charges 100 once ten bags have accumulated, and carries the remainder', () => {
    const base = newMatch(rules);
    const state = withOutcome({ ...base, bags: { ...base.bags, 'team-0': 8 } }, [
      { seat: 0, bid: 1, tricksWon: 3 },
      { seat: 2, bid: 1, tricksWon: 3 },
      { seat: 1, bid: 3, tricksWon: 3 },
      { seat: 3, bid: 4, tricksWon: 4 },
    ]);
    const scored = applyHandScoring(rules, state);
    // Bid 2, took 6: 20 + 4 overtricks = 24, then 8 + 4 = 12 bags pays one 100.
    expect(scored.bags['team-0']).toBe(2);
    expect(scored.teamScores['team-0']).toBe(24 - 100);
  });

  it('pays a nil bonus without folding the nil into the side contract', () => {
    const state = withOutcome(newMatch(rules), [
      { seat: 0, bid: 0, tricksWon: 0 },
      { seat: 2, bid: 4, tricksWon: 5 },
      { seat: 1, bid: 4, tricksWon: 4 },
      { seat: 3, bid: 4, tricksWon: 4 },
    ]);
    const scored = applyHandScoring(rules, state);
    // Contract is 4 (the nil is excluded), took 5: 40 + 1, plus the 100 bonus.
    expect(scored.teamScores['team-0']).toBe(141);
  });

  it('penalises a broken nil and counts its tricks as bags', () => {
    const state = withOutcome(newMatch(rules), [
      { seat: 0, bid: 0, tricksWon: 2 },
      { seat: 2, bid: 4, tricksWon: 4 },
      { seat: 1, bid: 3, tricksWon: 3 },
      { seat: 3, bid: 4, tricksWon: 4 },
    ]);
    const scored = applyHandScoring(rules, state);
    // Contract 4, side took 6: 40 + 2 overtricks - 100 penalty.
    expect(scored.teamScores['team-0']).toBe(-58);
    expect(scored.bags['team-0']).toBe(2);
  });
});

describe('scoring formula "exact-bid" (Oh Hell)', () => {
  const rules = loadRules('oh-hell');

  it('pays only for a bid hit exactly on the nose', () => {
    const state = withOutcome(newMatch(rules), [
      { seat: 0, bid: 2, tricksWon: 2 },
      { seat: 1, bid: 3, tricksWon: 1 },
      { seat: 2, bid: 0, tricksWon: 0 },
      { seat: 3, bid: 1, tricksWon: 4 },
    ]);
    const scored = applyHandScoring(rules, state);
    expect(scored.teamScores['seat-0']).toBe(12); // 10 + 2
    expect(scored.teamScores['seat-1']).toBe(0); // undertrick
    expect(scored.teamScores['seat-2']).toBe(10); // a made zero still pays
    expect(scored.teamScores['seat-3']).toBe(0); // overtricks are just as bad
  });

  it('marks an overtaken bid as MISSED, not MADE', () => {
    const state = withOutcome(newMatch(rules), [
      { seat: 0, bid: 1, tricksWon: 3 },
      { seat: 1, bid: 1, tricksWon: 1 },
      { seat: 2, bid: 1, tricksWon: 1 },
      { seat: 3, bid: 1, tricksWon: 1 },
    ]);
    const result = applyHandScoring(rules, state).lastResult!;
    expect(result.rows.find((r) => r.key === 'seat-0')!.contract).toBe('MISSED');
    expect(result.rows.find((r) => r.key === 'seat-1')!.contract).toBe('MADE');
  });
});

describe('bidding.forbidExactTotal (Oh Hell hook rule)', () => {
  const rules = loadRules('oh-hell');

  it('withholds from the last bidder the number that would balance the table', () => {
    const state = newMatch(rules); // 4 players, 7 cards each
    const threeBid: GameState = {
      ...state,
      phase: 'BIDDING',
      turnSeat: 3,
      players: state.players.map((p) =>
        p.seat === 3 ? p : { ...p, bid: 2 }, // 2 + 2 + 2 = 6, so 1 would total 7
      ),
    };
    const ids = generateLegalMoves(rules, threeBid).map((m) => m.id);
    expect(ids).not.toContain('bid-1');
    expect(ids).toContain('bid-0');
    expect(ids).toContain('bid-2');
  });

  it('leaves the bids of every other seat untouched', () => {
    const state = newMatch(rules);
    const firstToAct: GameState = { ...state, phase: 'BIDDING', turnSeat: 1 };
    const ids = generateLegalMoves(rules, firstToAct).map((m) => m.id);
    for (let v = 0; v <= 7; v++) expect(ids).toContain(`bid-${v}`);
  });
});

describe('scoring formula "capture"', () => {
  it('scores the tricks taken above the threshold, and nothing below it (Whist)', () => {
    const rules = loadRules('whist');
    const state = withOutcome(newMatch(rules), [
      { seat: 0, bid: null, tricksWon: 5 },
      { seat: 2, bid: null, tricksWon: 4 },
      { seat: 1, bid: null, tricksWon: 2 },
      { seat: 3, bid: null, tricksWon: 2 },
    ]);
    const scored = applyHandScoring(rules, state);
    expect(scored.teamScores['team-0']).toBe(3); // 9 tricks - 6
    expect(scored.teamScores['team-1']).toBe(0); // 4 tricks, below the book
  });

});

describe('scoring formula "threshold-win"', () => {
  it('pays a flat point for three of the four Tens, and nothing for fewer (Mendicot)', () => {
    const rules = loadRules('mendicot');
    const scored = applyHandScoring(rules, withOutcome(newMatch(rules), [], { 'team-0': 3, 'team-1': 1 }));
    expect(scored.teamScores['team-0']).toBe(1);
    expect(scored.teamScores['team-1']).toBe(0);
    expect(scored.lastResult!.rows.every((r) => r.contract === null)).toBe(true);
  });

  it('ignores the margin above the threshold — all four Tens still pays one', () => {
    const rules = loadRules('mendicot');
    const scored = applyHandScoring(rules, withOutcome(newMatch(rules), [], { 'team-0': 4, 'team-1': 0 }));
    expect(scored.teamScores['team-0']).toBe(1);
  });

  it('pays the side that takes seven of the thirteen tricks (Court Piece)', () => {
    const rules = loadRules('court-piece');
    const scored = applyHandScoring(rules, withOutcome(newMatch(rules), [
      { seat: 0, bid: null, tricksWon: 4 },
      { seat: 2, bid: null, tricksWon: 3 },
      { seat: 1, bid: null, tricksWon: 3 },
      { seat: 3, bid: null, tricksWon: 3 },
    ]));
    expect(scored.teamScores['team-0']).toBe(1); // 7 tricks
    expect(scored.teamScores['team-1']).toBe(0); // 6 tricks
  });
});

describe('scoring formula "declarer-contract" stake and defenders (29)', () => {
  it('moves only the declaring side, by a single game point', async () => {
    const { PluginManager } = await import('../plugin/plugin-manager.js');
    const { InMemoryPluginRepository } = await import('../plugin/plugin-repository.js');
    const shippedRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'games');
    const rules = (await PluginManager.loadAll(shippedRoot, new InMemoryPluginRepository())).get('29').rules;

    const base = newMatch(rules);
    const state: GameState = {
      ...base,
      phase: 'SCORING',
      declarerSeat: 0,
      players: base.players.map((p) => (p.seat === 0 ? { ...p, bid: 20 } : p)),
      handPoints: { 'team-0': 22, 'team-1': 6 },
    };

    const made = applyHandScoring(rules, state);
    expect(made.teamScores['team-0']).toBe(1); // not +20
    expect(made.teamScores['team-1']).toBe(0); // defenders unaffected

    const missed = applyHandScoring(rules, { ...state, handPoints: { 'team-0': 14, 'team-1': 14 } });
    expect(missed.teamScores['team-0']).toBe(-1);
    expect(missed.teamScores['team-1']).toBe(0);
  });
});

describe('scoring.fixedQuotasByDealerOffset (3-2-5)', () => {
  const rules = loadRules('325');

  it('stamps each seat its positional quota at deal time, with no bidding phase', () => {
    const state = newMatch(rules);
    expect(state.players[0]!.bid).toBe(2); // the dealer
    expect(state.players[1]!.bid).toBe(3); // dealer's left
    expect(state.players[2]!.bid).toBe(5); // dealer's right
  });

  it('reassigns quotas as the dealer rotates', () => {
    const second = startNextHand(rules, newMatch(rules), createRng(3));
    expect(second.dealerSeat).toBe(1);
    expect(second.players[1]!.bid).toBe(2);
    expect(second.players[2]!.bid).toBe(3);
    expect(second.players[0]!.bid).toBe(5);
  });

  it('scores the signed difference from the quota, in both directions', () => {
    const state = withOutcome(newMatch(rules), [
      { seat: 0, bid: 2, tricksWon: 4 },
      { seat: 1, bid: 3, tricksWon: 3 },
      { seat: 2, bid: 5, tricksWon: 3 },
    ]);
    const scored = applyHandScoring(rules, state);
    expect(scored.teamScores['seat-0']).toBe(2); // owed 2, took 4
    expect(scored.teamScores['seat-1']).toBe(0); // exactly on quota
    expect(scored.teamScores['seat-2']).toBe(-2); // owed 5, took 3
  });

  it('scores a quota of 3 as +3 for six tricks and -1 for two', () => {
    const overshoot = withOutcome(newMatch(rules), [{ seat: 1, bid: 3, tricksWon: 6 }]);
    expect(applyHandScoring(rules, overshoot).teamScores['seat-1']).toBe(3);

    const shortfall = withOutcome(newMatch(rules), [{ seat: 1, bid: 3, tricksWon: 2 }]);
    expect(applyHandScoring(rules, shortfall).teamScores['seat-1']).toBe(-1);
  });

  it('shows the chooser only the first five cards while trump is being chosen', () => {
    const state = newMatch(rules);
    expect(state.phase).toBe('TRUMP_SELECTION');
    expect(state.players[2]!.hand).toHaveLength(10);

    // The staged deal: all ten are held, but only five are visible to their
    // own owner until trump is fixed.
    const duringSelection = maskGameState(rules, state, 2);
    expect(duringSelection.players[2]!.hand).toHaveLength(5);
    expect(duringSelection.players[2]!.hand).toEqual(state.players[2]!.hand.slice(0, 5));

    const afterSelection = maskGameState(rules, applyMove(rules, state, 'trump-S'), 2);
    expect(afterSelection.players[2]!.hand).toHaveLength(10);
  });
});
