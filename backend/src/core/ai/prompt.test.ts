/**
 * Prompt compilation, focused on the difficulty-scaled trick memory.
 *
 * Two properties matter here and neither is obvious from the types. A bot must
 * be shown the *most recent* tricks rather than the earliest, since forgetting
 * works backwards. And whenever it is shown less than the whole hand, the
 * prompt has to say so — partial history presented as complete is worse than
 * none at all, because a model that believes it has seen every trick will play
 * confidently into a card that already fell.
 */

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginManager, type GamePlugin } from '../plugin/plugin-manager.js';
import { InMemoryPluginRepository } from '../plugin/plugin-repository.js';
import { createRng } from '../engine/deck.js';
import { createMatch } from '../engine/state.js';
import { generateLegalMoves } from '../engine/legal-moves.js';
import { applyMove } from '../engine/apply-move.js';
import { maskGameState } from '../obfuscation/fog-of-war.js';
import { compilePrompt } from './prompt.js';
import type { GameState } from '@hcg/shared';

const gamesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'games');

interface Fixture {
  readonly plugin: GamePlugin;
  readonly state: GameState;
}

/** Drives 29 with legal_moves[0] until exactly `count` tricks have completed. */
async function afterTricks(count: number): Promise<Fixture> {
  const plugins = await PluginManager.loadAll(gamesRoot, new InMemoryPluginRepository());
  const plugin = plugins.get('29');
  const { rules } = plugin;

  let state = createMatch({
    rules,
    gameId: '29',
    matchId: 'm-prompt',
    playerCount: 4,
    dealerSeat: 0,
    playerNames: ['A', 'B', 'C', 'D'],
    aiSeats: new Set([1, 2, 3]),
    rng: createRng(7),
  });

  for (let i = 0; i < 500 && state.completedTricks.length < count; i++) {
    const moves = generateLegalMoves(rules, state);
    if (moves.length === 0) throw new Error(`No legal moves in phase "${state.phase}"`);
    state = applyMove(rules, state, moves[0]!.id);
  }
  if (state.completedTricks.length !== count) {
    throw new Error(`Wanted ${count} completed tricks, reached ${state.completedTricks.length}`);
  }
  return { plugin, state };
}

/** The user-prompt JSON a given memory setting produces for the seat on turn. */
function payloadFor(fixture: Fixture, memoryFraction?: number): Record<string, unknown> {
  const masked = maskGameState(fixture.plugin.rules, fixture.state, fixture.state.turnSeat);
  const { userPrompt } = compilePrompt(
    fixture.plugin,
    masked,
    memoryFraction === undefined ? {} : { memoryFraction },
  );
  return JSON.parse(userPrompt) as Record<string, unknown>;
}

describe('compilePrompt trick memory', () => {
  it('shows the whole hand by default, so a caller that does not opt in loses nothing', async () => {
    const fixture = await afterTricks(4);
    const payload = payloadFor(fixture);
    expect(payload.completedTricksPlayed).toBe(4);
    expect(payload.completedTricksShown).toBe(4);
    expect(payload.completedTricks).toHaveLength(4);
  });

  it('shows nothing at fraction 0 but still admits how much it is withholding', async () => {
    const fixture = await afterTricks(4);
    const payload = payloadFor(fixture, 0);
    expect(payload.completedTricksShown).toBe(0);
    expect(payload.completedTricks).toEqual([]);
    // The honesty that makes limited memory safe rather than actively harmful:
    // the model can tell it is missing four tricks, so it hedges instead of
    // assuming an unseen card is still live.
    expect(payload.completedTricksPlayed).toBe(4);
  });

  it('keeps the most recent tricks, not the earliest', async () => {
    const fixture = await afterTricks(4);
    const payload = payloadFor(fixture, 0.25); // ceil(0.25 * 4) = 1

    expect(payload.completedTricksShown).toBe(1);
    const shown = payload.completedTricks as { cards: string[]; wonBy: number }[];
    const mostRecent = fixture.state.completedTricks[3]!;
    expect(shown[0]!.wonBy).toBe(mostRecent.winnerSeat);
    expect(shown[0]!.cards).toEqual(mostRecent.cards.map((c) => `${c.seat}:${c.card}`));
  });

  it('widens the window across the level ladder', async () => {
    const fixture = await afterTricks(4);
    // easy 0 -> 0, medium 0.25 -> 1, hard 0.6 -> ceil(2.4) = 3, extreme 1 -> 4.
    for (const [fraction, expected] of [
      [0, 0],
      [0.25, 1],
      [0.6, 3],
      [1, 4],
    ] as const) {
      const payload = payloadFor(fixture, fraction);
      expect(payload.completedTricksShown).toBe(expected);
      expect(payload.completedTricks).toHaveLength(expected);
    }
  });

  it('converges early in a hand, when there is nothing yet to remember', async () => {
    const fixture = await afterTricks(1);
    // Every level except easy sees the single completed trick — the gap is
    // meant to open up late in the hand, not on trick two.
    expect(payloadFor(fixture, 0).completedTricksShown).toBe(0);
    expect(payloadFor(fixture, 0.25).completedTricksShown).toBe(1);
    expect(payloadFor(fixture, 0.6).completedTricksShown).toBe(1);
    expect(payloadFor(fixture, 1).completedTricksShown).toBe(1);
  });

  it('trims only the prompt, never the masked state the human client also reads', async () => {
    const fixture = await afterTricks(4);
    const masked = maskGameState(fixture.plugin.rules, fixture.state, fixture.state.turnSeat);

    compilePrompt(fixture.plugin, masked, { memoryFraction: 0 });

    // Masking answers "what may this viewer see"; memory answers "how much
    // does this bot use". If difficulty leaked into the mask, an easy bot at
    // the table would blank the trick history of every human watching.
    expect(masked.completedTricks).toHaveLength(4);
  });

  it('tells the model in the system prompt not to trust gaps in the history', async () => {
    const fixture = await afterTricks(4);
    const masked = maskGameState(fixture.plugin.rules, fixture.state, fixture.state.turnSeat);
    const { systemPrompt } = compilePrompt(fixture.plugin, masked, { memoryFraction: 0.25 });
    expect(systemPrompt).toContain('completedTricksShown');
    expect(systemPrompt).toContain('completedTricksPlayed');
  });
});
