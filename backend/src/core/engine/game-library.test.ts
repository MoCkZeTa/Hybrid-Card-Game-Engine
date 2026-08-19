/**
 * The `game-plugins/` library at the repo root — every plugin there must load
 * through the same validator the shipped games do, and must actually play a
 * full match to completion.
 *
 * The point of this file is that these games exist purely as data. If a
 * plugin here can be dealt, bid, played and scored without the engine knowing
 * its name, the "adding a game requires no engine code" promise is holding;
 * if one of them needs a special case, this is where that shows up.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GameState, RulesDsl } from '@hcg/shared';
import { validateRulesDsl, handLimit, resolveDeal, totalCards } from '@hcg/shared';
import { createRng } from './deck.js';
import { createMatch, startNextHand } from './state.js';
import { generateLegalMoves } from './legal-moves.js';
import { applyMove } from './apply-move.js';
import { applyHandScoring, matchEndReason } from './scoring.js';

const libraryRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', '..', 'game-plugins',
);

interface LibraryPlugin {
  readonly dir: string;
  readonly rules: RulesDsl;
  readonly strategy: string;
}

function loadLibrary(): LibraryPlugin[] {
  return readdirSync(libraryRoot)
    .filter((entry) => statSync(path.join(libraryRoot, entry)).isDirectory())
    .map((entry) => {
      const dir = path.join(libraryRoot, entry);
      return {
        dir: entry,
        rules: JSON.parse(readFileSync(path.join(dir, 'rules.json'), 'utf-8')) as RulesDsl,
        strategy: readFileSync(path.join(dir, 'strategy.md'), 'utf-8'),
      };
    });
}

const library = loadLibrary();

/** Plays one hand to its SCORING phase by always taking the first legal move. */
function playHand(rules: RulesDsl, initial: GameState): GameState {
  let state = initial;
  for (let i = 0; i < 5000; i++) {
    if (rules.phases.find((p) => p.name === state.phase)!.kind === 'SCORING') return state;
    const moves = generateLegalMoves(rules, state);
    expect(moves.length, `no legal move at phase ${state.phase}, seat ${state.turnSeat}`).toBeGreaterThan(0);
    state = applyMove(rules, state, moves[0]!.id);
  }
  throw new Error(`"${rules.displayName}" never reached SCORING`);
}

function newMatch(rules: RulesDsl, seed: number): GameState {
  const count = rules.players.defaultCount;
  return createMatch({
    rules,
    // These plugins are never registered, so there is no assigned id to use —
    // the display name is enough to make a failure message readable.
    gameId: rules.displayName,
    matchId: `lib-${rules.displayName}-${seed}`,
    playerCount: count,
    dealerSeat: 0,
    playerNames: Array.from({ length: count }, (_, i) => `P${i}`),
    aiSeats: new Set(),
    rng: createRng(seed),
  });
}

describe('game-plugins library', () => {
  it('contains plugins', () => {
    expect(library.length).toBeGreaterThan(0);
  });

  for (const plugin of library) {
    describe(plugin.dir, () => {
      it('passes validateRulesDsl', () => {
        const result = validateRulesDsl(plugin.rules);
        expect(result.errors).toEqual([]);
        expect(result.valid).toBe(true);
      });

      it('has a non-empty strategy guide', () => {
        expect(plugin.strategy.trim().length).toBeGreaterThan(0);
      });

      // The inverse of the old "gameId matches its directory name" check.
      // Identity is the server's to assign, so carrying one in the document is
      // now a validation failure — this catches a library file that predates
      // that rule, or a copy-paste from an old plugin.
      it('does not declare a gameId', () => {
        expect(plugin.rules).not.toHaveProperty('gameId');
      });

      it('names itself', () => {
        expect(plugin.rules.displayName.trim().length).toBeGreaterThan(0);
      });

      it('deals a whole number of cards at every supported table size and hand', () => {
        const { rules } = plugin;
        for (let n = rules.players.min; n <= rules.players.max; n++) {
          for (let hand = 1; hand <= Math.min(handLimit(rules), 13); hand++) {
            const { handSize, kittySize } = resolveDeal(rules, n, hand);
            expect(handSize).toBeGreaterThan(0);
            expect(kittySize).toBeGreaterThanOrEqual(0);
            expect(handSize * n + kittySize).toBe(totalCards(rules));
          }
        }
      });

      it('plays a full match to a GAME result', () => {
        const { rules } = plugin;
        let state = newMatch(rules, 7);

        for (let hand = 0; hand < handLimit(rules) + 1; hand++) {
          state = applyHandScoring(rules, playHand(rules, state));
          const result = state.lastResult!;
          expect(result.rows.length).toBeGreaterThan(0);
          if (result.scope === 'GAME') {
            expect(result.winnerKeys.length).toBeGreaterThan(0);
            expect(matchEndReason(rules, state.handNumber, state.teamScores)).not.toBeNull();
            return;
          }
          state = startNextHand(rules, state, createRng(hand + 100));
        }
        throw new Error(`"${rules.displayName}" never produced a GAME result`);
      });

      it('empties every hand by the end of a deal', () => {
        const { rules } = plugin;
        const state = playHand(rules, newMatch(rules, 21));
        for (const player of state.players) expect(player.hand).toHaveLength(0);
      });
    });
  }
});
