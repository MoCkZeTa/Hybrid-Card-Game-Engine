/**
 * Covers the key-pool behaviour of `GroqProvider` — that consecutive calls
 * spread across the keys, and that a rate-limited key hands off to the next
 * one inside the same turn rather than failing the AI's move.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { GroqProvider } from './groq-provider.js';
import { LLMProviderError } from './provider.js';

const KEYS = ['key-a', 'key-b', 'key-c', 'key-d'];

function request() {
  return {
    systemPrompt: 'sys',
    userPrompt: 'usr',
    legalMoveIds: ['m1'],
    signal: new AbortController().signal,
  };
}

function ok(): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: '{"moveId":"m1"}' } }] }), { status: 200 });
}

function status(code: number): Response {
  return new Response('nope', { status: code });
}

/** The bearer token each recorded call went out with. */
function keysUsed(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map((call) => {
    const init = call[1] as RequestInit;
    return String((init.headers as Record<string, string>).Authorization).replace('Bearer ', '');
  });
}

function provider(): GroqProvider {
  return new GroqProvider({ apiKeys: KEYS, model: 'test-model' });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GroqProvider key rotation', () => {
  it('reports the size of its key pool', () => {
    expect(provider().keyCount).toBe(4);
  });

  it('rejects an empty pool rather than sending unauthenticated requests', () => {
    expect(() => new GroqProvider({ apiKeys: ['', '   '], model: 'test-model' })).toThrow(/at least one apiKey/);
  });

  it('spreads consecutive calls across every key before reusing one', async () => {
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetchMock);

    const p = provider();
    for (let i = 0; i < 5; i++) await p.decide(request());

    expect(keysUsed(fetchMock)).toEqual(['key-a', 'key-b', 'key-c', 'key-d', 'key-a']);
  });

  it('falls through to the next key when one is rate-limited', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init: unknown) => {
      const auth = String((( init as RequestInit).headers as Record<string, string>).Authorization);
      return auth.includes('key-a') ? status(429) : ok();
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await provider().decide(request());

    expect(result.moveId).toBe('m1');
    expect(keysUsed(fetchMock as ReturnType<typeof vi.fn>)).toEqual(['key-a', 'key-b']);
  });

  it('gives up once every key is exhausted', async () => {
    const fetchMock = vi.fn(async () => status(429));
    vi.stubGlobal('fetch', fetchMock);

    await expect(provider().decide(request())).rejects.toBeInstanceOf(LLMProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does not burn the other keys on a malformed request', async () => {
    const fetchMock = vi.fn(async () => status(400));
    vi.stubGlobal('fetch', fetchMock);

    await expect(provider().decide(request())).rejects.toBeInstanceOf(LLMProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops retrying once the turn deadline has aborted', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => {
      controller.abort();
      return status(429);
    });
    vi.stubGlobal('fetch', fetchMock);

    const p = provider();
    await expect(p.decide({ ...request(), signal: controller.signal })).rejects.toBeInstanceOf(LLMProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
