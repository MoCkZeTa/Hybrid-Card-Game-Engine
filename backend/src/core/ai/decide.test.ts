import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginManager } from '../plugin/plugin-manager.js';
import { InMemoryPluginRepository } from '../plugin/plugin-repository.js';
import { createRng } from '../engine/deck.js';
import { createMatch } from '../engine/state.js';
import { decideTurn } from './decide.js';
import type { LLMDecisionRequest, LLMDecisionResponse, LLMProvider } from './provider.js';

const gamesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'games');

class StubProvider implements LLMProvider {
  readonly name = 'stub';
  constructor(private readonly behavior: (req: LLMDecisionRequest) => Promise<LLMDecisionResponse>) {}
  decide(req: LLMDecisionRequest): Promise<LLMDecisionResponse> {
    return this.behavior(req);
  }
}

async function loadCallbreakMatch() {
  const plugins = await PluginManager.loadAll(gamesRoot, new InMemoryPluginRepository());
  const plugin = plugins.get('callbreak');
  const state = createMatch({
    rules: plugin.rules,
    gameId: plugin.gameId,
    matchId: 'ai-1',
    playerCount: 4,
    dealerSeat: 0,
    playerNames: ['A', 'B', 'C', 'D'],
    aiSeats: new Set([0, 1, 2, 3]),
    rng: createRng(21),
  });
  return { plugin, state };
}

describe('decideTurn', () => {
  it('returns the LLM\'s chosen move when it responds with a valid moveId', async () => {
    const { plugin, state } = await loadCallbreakMatch();
    const provider = new StubProvider(async (req) => ({ moveId: req.legalMoveIds[0]!, reasoning: 'test' }));

    const decision = await decideTurn({ rules: plugin.rules, plugin, state, seat: state.turnSeat, provider });
    expect(decision.source).toBe('llm');
    expect(decision.moveId).toBe((await import('../engine/legal-moves.js')).generateLegalMoves(plugin.rules, state)[0]!.id);
  });

  it('falls back to legal_moves[0] when the LLM returns an id outside the legal set (PRD 5.2)', async () => {
    const { plugin, state } = await loadCallbreakMatch();
    const provider = new StubProvider(async () => ({ moveId: 'totally-made-up-move' }));

    const decision = await decideTurn({ rules: plugin.rules, plugin, state, seat: state.turnSeat, provider });
    expect(decision.source).toBe('fallback');
    expect(decision.reasoning).toContain('invalid moveId');
  });

  it('falls back to legal_moves[0] when the LLM call throws', async () => {
    const { plugin, state } = await loadCallbreakMatch();
    const provider = new StubProvider(async () => {
      throw new Error('simulated network failure');
    });

    const decision = await decideTurn({ rules: plugin.rules, plugin, state, seat: state.turnSeat, provider });
    expect(decision.source).toBe('fallback');
    expect(decision.reasoning).toContain('simulated network failure');
  });

  it('falls back when the LLM exceeds the timeout budget (PRD 6)', async () => {
    const { plugin, state } = await loadCallbreakMatch();
    const provider = new StubProvider(
      (req) =>
        new Promise((resolve, reject) => {
          req.signal.addEventListener('abort', () => reject(new Error('aborted')));
          // Never resolves on its own within the test's short timeout window.
        }),
    );

    const decision = await decideTurn({
      rules: plugin.rules,
      plugin,
      state,
      seat: state.turnSeat,
      provider,
      llmTimeoutMs: 30,
    });
    expect(decision.source).toBe('fallback');
  }, 2000);

  it('skips the LLM entirely and returns "forced" when only one legal move exists', async () => {
    const { plugin, state } = await loadCallbreakMatch();
    let called = false;
    const provider = new StubProvider(async (req) => {
      called = true;
      return { moveId: req.legalMoveIds[0]! };
    });

    // BIDDING phase for Callbreak always has multiple bid options (1..13), so
    // force a single-option scenario directly: a hand with exactly one card.
    const singleCardState = {
      ...state,
      phase: 'PLAYING',
      players: state.players.map((p) => (p.seat === state.turnSeat ? { ...p, hand: [p.hand[0]!] } : p)),
    };

    const decision = await decideTurn({
      rules: plugin.rules,
      plugin,
      state: singleCardState,
      seat: state.turnSeat,
      provider,
    });
    expect(decision.source).toBe('forced');
    expect(called).toBe(false);
  });
});
