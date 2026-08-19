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
});
