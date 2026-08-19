/**
 * Groq implementation of `LLMProvider`. Groq exposes an OpenAI-compatible
 * chat-completions endpoint, so a plain `fetch` covers it with no SDK
 * dependency — kept intentionally thin so a future `GeminiProvider` is the
 * only other file this pattern needs to be copied into.
 */

import { LLMProviderError, parseDecisionResponse, type LLMDecisionRequest, type LLMDecisionResponse, type LLMProvider } from './provider.js';

export interface GroqProviderOptions {
  /**
   * One or more Groq keys. Calls round-robin across them so a single free-tier
   * key's per-minute budget isn't the ceiling for the whole server, and a key
   * that answers 429 (or has been revoked) is skipped for that call rather
   * than failing the turn.
   */
  readonly apiKeys: readonly string[];
  readonly model: string;
  readonly baseUrl?: string;
  /** Only meaningful for reasoning-capable models (e.g. `openai/gpt-oss-120b`); omitted entirely for plain chat models since they reject the field. */
  readonly reasoningEffort?: 'low' | 'medium' | 'high';
}

/**
 * Statuses where a *different* key plausibly succeeds: rate limit, an expired
 * or revoked key, and Groq-side faults. A 400 means the request body itself is
 * wrong, so retrying it four times only burns the remaining keys' quota.
 */
function isWorthRetryingOnAnotherKey(status: number, body: string): boolean {
  if (status === 429 || status === 401 || status === 403 || status >= 500) return true;
  // Groq's json_object mode validates the completion server-side and returns
  // this specific 400 when the model's output didn't parse as JSON — in
  // practice that's near-always a reasoning model that spent its whole
  // max_tokens budget on hidden chain-of-thought and got cut off before
  // emitting the closing brace, not a malformed request. A fresh attempt
  // (different key, same token budget) samples a shorter CoT often enough to
  // be worth it, unlike a genuinely bad request which fails identically every
  // time.
  if (status === 400 && /failed to validate json/i.test(body)) return true;
  return false;
}

/**
 * `max_tokens` budget for the chat completion. Reasoning models spend part of
 * it on hidden chain-of-thought before ever emitting the JSON answer, and
 * higher `reasoning_effort` means more of that hidden spend — too small a
 * budget truncates the completion before the JSON closes, which Groq reports
 * as a 400 "Failed to validate JSON" rather than just returning the partial
 * text. Plain chat models (no reasoningEffort) never touch this path, so 500
 * is generous for them.
 */
export function maxTokensFor(reasoningEffort: 'low' | 'medium' | 'high' | undefined): number {
  switch (reasoningEffort) {
    case 'high':
      return 3500;
    case 'medium':
      return 2200;
    case 'low':
      return 1400;
    default:
      return 500;
  }
}

export class GroqProvider implements LLMProvider {
  readonly name = 'groq';
  private readonly apiKeys: readonly string[];
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly reasoningEffort?: 'low' | 'medium' | 'high';
  /** Where the next call starts in the key list; advances once per `decide()`. */
  private cursor = 0;

  constructor(opts: GroqProviderOptions) {
    const keys = opts.apiKeys.filter((k) => k.trim().length > 0);
    if (keys.length === 0) throw new Error('GroqProvider requires at least one apiKey (GROQ_API_KEYS or GROQ_API_KEY)');
    this.apiKeys = keys;
    this.model = opts.model;
    this.baseUrl = opts.baseUrl ?? 'https://api.groq.com/openai/v1';
    this.reasoningEffort = opts.reasoningEffort;
  }

  /** How many keys are in the pool — surfaced for the startup log. */
  get keyCount(): number {
    return this.apiKeys.length;
  }

  async decide(request: LLMDecisionRequest): Promise<LLMDecisionResponse> {
    const start = this.cursor;
    this.cursor = (this.cursor + 1) % this.apiKeys.length;

    let lastError: unknown;
    for (let attempt = 0; attempt < this.apiKeys.length; attempt++) {
      // The whole call sits under one `LLM_TIMEOUT_MS` abort signal, so once
      // that fires there is no time left to try the next key either.
      if (request.signal.aborted) break;

      const keyIndex = (start + attempt) % this.apiKeys.length;
      try {
        return await this.decideWithKey(request, this.apiKeys[keyIndex]!);
      } catch (err) {
        lastError = err;
        if (!(err instanceof RetryableGroqError)) throw new LLMProviderError(this.name, err);
      }
    }

    throw new LLMProviderError(this.name, lastError ?? new Error('no Groq key produced a response'));
  }

  private async decideWithKey(request: LLMDecisionRequest, apiKey: string): Promise<LLMDecisionResponse> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: request.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0.3,
          max_tokens: maxTokensFor(this.reasoningEffort),
          response_format: { type: 'json_object' },
          ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}),
          messages: [
            { role: 'system', content: request.systemPrompt },
            { role: 'user', content: request.userPrompt },
          ],
        }),
      });
    } catch (err) {
      // Network-level failure (DNS, connection reset). Not this key's fault,
      // but another key means another connection attempt, so it's worth one.
      if (request.signal.aborted) throw err;
      throw new RetryableGroqError(`Groq request failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const message = `Groq API returned ${res.status} ${res.statusText}: ${body.slice(0, 300)}`;
      if (isWorthRetryingOnAnotherKey(res.status, body)) throw new RetryableGroqError(message);
      throw new Error(message);
    }

    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new Error('Groq API response had no message content');

    return parseDecisionResponse(content);
  }
}

/** Marks a failure that a different key might not hit. Internal to this file. */
class RetryableGroqError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableGroqError';
  }
}
