/**
 * Covers `createBotTiersFromEnv`: the four `BotLevel` tiers get the right
 * `reasoning_effort`/timeout ladder for Groq, share one provider for Gemini,
 * and `GROQ_REASONING_EFFORT` maps onto the right default level.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBotTiersFromEnv, type RouterEnv } from './provider-router.js';

function request(legalMoveIds: readonly string[] = ['m1']) {
  return {
    systemPrompt: 'sys',
    userPrompt: 'usr',
    legalMoveIds,
    signal: new AbortController().signal,
  };
}

function ok(): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: '{"moveId":"m1"}' } }] }), { status: 200 });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createBotTiersFromEnv — Groq', () => {
  const env: RouterEnv = { LLM_PROVIDER: 'groq', GROQ_API_KEYS: 'test-key', GROQ_MODEL: 'test-model' };

  it('gives each level the timeout ladder anchored at extreme ~= 10s', () => {
    const { tiers } = createBotTiersFromEnv(env);
    expect(tiers.easy!.llmTimeoutMs).toBe(1500);
    expect(tiers.medium!.llmTimeoutMs).toBe(4000);
    expect(tiers.hard!.llmTimeoutMs).toBe(6300);
    expect(tiers.extreme!.llmTimeoutMs).toBe(10_000);
  });

  it('gives each level a distinct trick-memory window, from blind at easy to total recall at extreme', () => {
    const { tiers } = createBotTiersFromEnv(env);
    expect(tiers.easy!.memoryFraction).toBe(0);
    expect(tiers.extreme!.memoryFraction).toBe(1);
    // Strictly increasing — two levels that remember the same amount would be
    // separated only by thinking time, which is the weaker of the two levers.
    expect(tiers.medium!.memoryFraction).toBeGreaterThan(tiers.easy!.memoryFraction);
    expect(tiers.hard!.memoryFraction).toBeGreaterThan(tiers.medium!.memoryFraction);
    expect(tiers.extreme!.memoryFraction).toBeGreaterThan(tiers.hard!.memoryFraction);
  });

  it('omits reasoning_effort for easy and steps low/medium/high through the rest, on the same model', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init: unknown) => ok());
    vi.stubGlobal('fetch', fetchMock);

    const { tiers } = createBotTiersFromEnv(env);
    for (const level of ['easy', 'medium', 'hard', 'extreme'] as const) {
      await tiers[level]!.provider.decide(request());
    }

    const bodies = fetchMock.mock.calls.map((call) => JSON.parse((call[1]! as RequestInit).body as string));
    expect(bodies.map((b) => b.reasoning_effort)).toEqual([undefined, 'low', 'medium', 'high']);
    expect(bodies.every((b) => b.model === 'test-model')).toBe(true);
  });

  it('maps GROQ_REASONING_EFFORT onto the matching default level', () => {
    expect(createBotTiersFromEnv({ ...env, GROQ_REASONING_EFFORT: undefined }).defaultLevel).toBe('easy');
    expect(createBotTiersFromEnv({ ...env, GROQ_REASONING_EFFORT: 'low' }).defaultLevel).toBe('medium');
    expect(createBotTiersFromEnv({ ...env, GROQ_REASONING_EFFORT: 'medium' }).defaultLevel).toBe('hard');
    expect(createBotTiersFromEnv({ ...env, GROQ_REASONING_EFFORT: 'high' }).defaultLevel).toBe('extreme');
    // Not one of Groq's recognised values — same as unset.
    expect(createBotTiersFromEnv({ ...env, GROQ_REASONING_EFFORT: 'nonsense' }).defaultLevel).toBe('easy');
  });
});

describe('createBotTiersFromEnv — Gemini', () => {
  const env: RouterEnv = { LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'test-key', GEMINI_MODEL: 'test-gemini-model' };

  it('shares one provider instance across all four levels (no reasoning-effort knob to vary)', () => {
    const { tiers } = createBotTiersFromEnv(env);
    expect(tiers.easy!.provider).toBe(tiers.medium!.provider);
    expect(tiers.medium!.provider).toBe(tiers.hard!.provider);
    expect(tiers.hard!.provider).toBe(tiers.extreme!.provider);
  });

  it('still scales the timeout per level even though quality does not vary', () => {
    const { tiers } = createBotTiersFromEnv(env);
    expect(tiers.easy!.llmTimeoutMs).toBe(1500);
    expect(tiers.extreme!.llmTimeoutMs).toBe(10_000);
  });

  it('separates the levels by trick memory despite the shared provider instance', () => {
    // This is why memory is worth having as a lever at all: `reasoning_effort`
    // is Groq-only, so without it every Gemini level would play identically
    // and differ by nothing but how long it was allowed to take.
    const { tiers } = createBotTiersFromEnv(env);
    expect(tiers.easy!.provider).toBe(tiers.extreme!.provider);
    expect(tiers.easy!.memoryFraction).toBe(0);
    expect(tiers.extreme!.memoryFraction).toBe(1);
  });
});

describe('createBotTiersFromEnv — no credentials configured', () => {
  /**
   * The rule: a missing API key degrades the server, it does not stop it.
   *
   * `config/env.ts` rates an absent `GROQ_API_KEYS` as a warning rather than a
   * fatal, on the stated grounds that the engine falls back to `legal_moves[0]`
   * and the game still runs. `CLAUDE.md` makes the same promise about an empty
   * `.env`. Neither was true — `GroqProvider`'s constructor threw and took the
   * whole boot with it — and nothing failed until someone actually started the
   * server with no key, which nobody does on a machine that has one.
   */
  it('builds tiers instead of throwing when Groq has no keys', () => {
    expect(() => createBotTiersFromEnv({ LLM_PROVIDER: 'groq' })).not.toThrow();

    const { tiers } = createBotTiersFromEnv({ LLM_PROVIDER: 'groq' });
    // Named for what is missing, because this string is what shows up in the
    // AI decision log on every fallback turn.
    expect(tiers.easy!.provider.name).toBe('groq (unconfigured)');
    // The difficulty ladder is still wired up, so configuring a key later
    // needs no other change.
    expect(tiers.easy!.llmTimeoutMs).toBeLessThan(tiers.extreme!.llmTimeoutMs);
  });

  it('does the same for Gemini', () => {
    expect(() => createBotTiersFromEnv({ LLM_PROVIDER: 'gemini' })).not.toThrow();
    expect(createBotTiersFromEnv({ LLM_PROVIDER: 'gemini' }).tiers.hard!.provider.name).toBe('gemini (unconfigured)');
  });

  it('rejects rather than resolving, so decideTurn takes its fallback path', async () => {
    // The distinction that matters: this provider must *fail*, not quietly
    // return the first legal move itself. A misconfigured server that plays on
    // in silence is indistinguishable from a working one in the logs.
    const { tiers } = createBotTiersFromEnv({ LLM_PROVIDER: 'groq' });
    await expect(tiers.easy!.provider.decide(request())).rejects.toThrow(/GROQ_API_KEYS/);
  });

  it('still uses the real provider when a key is present', () => {
    const { tiers } = createBotTiersFromEnv({ LLM_PROVIDER: 'groq', GROQ_API_KEYS: 'gsk_real' });
    expect(tiers.easy!.provider.name).toBe('groq');
  });
});
