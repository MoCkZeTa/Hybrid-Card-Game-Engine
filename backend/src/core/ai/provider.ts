/**
 * The "wall socket" for LLM inference (PRD 2, "Direct API Router").
 *
 * Nothing in the engine or the orchestrator (`decide.ts`) knows or cares
 * which company answers a decision request — they only see this interface.
 * `GroqProvider` is the one concrete implementation wired up today (an API
 * key is already available); a `GeminiProvider` satisfying the same
 * interface can be added later without touching anything else.
 */

export interface LLMDecisionRequest {
  readonly systemPrompt: string;
  readonly userPrompt: string;
  /** The bounded choice set the response must resolve to one member of. */
  readonly legalMoveIds: readonly string[];
  readonly signal: AbortSignal;
}

export interface LLMDecisionResponse {
  readonly moveId: string;
  /** Free-text rationale for logs/UI (PRD 5.2). Never trusted for game logic. */
  readonly reasoning?: string;
}

export interface LLMProvider {
  readonly name: string;
  decide(request: LLMDecisionRequest): Promise<LLMDecisionResponse>;
}

/**
 * Stands in for a provider that has no credentials configured.
 *
 * Every concrete provider throws from its constructor when handed no API key,
 * which is right for the class — an instance that cannot possibly work should
 * not exist. It is wrong for *boot*, though, and the two got conflated: with no
 * `GROQ_API_KEYS` the server died at startup, even though `config/env.ts`
 * classes that exact condition as non-fatal on the stated grounds that "the
 * engine's fallback is to play `legal_moves[0]`, so the game still runs", and
 * `CLAUDE.md` promises an empty `.env` works.
 *
 * It didn't run and it didn't work. This is what makes both true: a provider
 * that always fails, so `decideTurn` takes the deterministic fallback path it
 * already has for a timed-out or broken API — the difference being that the
 * reason string says the key is missing, instead of the server never starting
 * and saying nothing about which of its dozen settings was to blame.
 *
 * Deliberately not a silent "play the first legal move" provider: that would
 * make a misconfigured server indistinguishable from a working one at the log
 * level, which is the failure mode this whole pass exists to remove.
 */
export class UnconfiguredProvider implements LLMProvider {
  readonly name: string;

  constructor(
    /** Named for the provider it replaces, so logs point at the right setting. */
    intendedProvider: string,
    private readonly reason: string,
  ) {
    this.name = `${intendedProvider} (unconfigured)`;
  }

  decide(): Promise<LLMDecisionResponse> {
    return Promise.reject(new LLMProviderError(this.name, this.reason));
  }
}

export class LLMProviderError extends Error {
  constructor(providerName: string, cause: unknown) {
    super(`${providerName} provider failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'LLMProviderError';
  }
}

/**
 * Pulls a `{ moveId, reasoning? }` object out of a model response. Tolerates
 * the common failure mode of a chat model wrapping JSON in a markdown code
 * fence even when asked not to.
 */
export function parseDecisionResponse(raw: string): LLMDecisionResponse {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    throw new Error(`Model response was not valid JSON: ${(err as Error).message}. Raw: ${raw.slice(0, 200)}`);
  }

  if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { moveId?: unknown }).moveId !== 'string') {
    throw new Error(`Model response missing a string "moveId" field. Raw: ${raw.slice(0, 200)}`);
  }

  const obj = parsed as { moveId: string; reasoning?: unknown };
  return {
    moveId: obj.moveId,
    reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : undefined,
  };
}

// ---------------------------------------------------------------------------
// Free-form completion
// ---------------------------------------------------------------------------

/**
 * The second thing this server asks an LLM to do: author text, rather than pick
 * one identifier out of a bounded set.
 *
 * Kept as a **separate interface** from `LLMProvider` on purpose. `decide()` is
 * the hot path — it runs once per AI seat per turn, under a per-level timeout,
 * with a ~500 token budget and a guaranteed deterministic fallback. Authoring a
 * `rules.json` is the opposite of all four: it happens once, takes seconds,
 * needs thousands of tokens, and has no "first legal move" to fall back on.
 * Widening `LLMProvider.decide` to cover both would put an authoring-sized
 * token budget one typo away from the game loop.
 *
 * A concrete provider implements whichever it can. `GroqProvider` and
 * `GeminiProvider` implement both and share their transport internally.
 */
export interface LLMCompletionRequest {
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly signal: AbortSignal;
  /** Authoring needs a far larger budget than a move decision — see `maxTokensFor`. */
  readonly maxTokens: number;
  /** Defaults to the provider's own choice when omitted. */
  readonly temperature?: number;
  /**
   * Ask the provider to constrain the response to a JSON object where it
   * supports doing so. A hint, not a guarantee: `extractJsonObject` still has
   * to cope with a model that fences or prefaces its answer anyway.
   */
  readonly json?: boolean;
}

export interface LLMCompletionProvider {
  readonly name: string;
  /** The model id in use, for logs and for the UI's "drafted by" footer. */
  readonly model: string;
  complete(request: LLMCompletionRequest): Promise<string>;
}

/**
 * Pulls the first complete JSON object out of a model response.
 *
 * `parseDecisionResponse` above strips a markdown fence and parses; that is
 * enough for a 40-token answer. An authoring response is thousands of tokens
 * and fails in more ways: a preamble sentence before the brace, a trailing
 * "Let me know if you'd like…", a fence *and* a preamble. Rather than add a
 * fourth `.replace()` each time a new one shows up, this scans for the outermost
 * balanced `{...}` — respecting string literals and escapes, so a brace inside
 * `"strategy"` text cannot end the scan early — and parses that.
 */
export function extractJsonObject(raw: string): unknown {
  const start = raw.indexOf('{');
  if (start === -1) throw new Error(`Model response contained no JSON object. Raw: ${raw.slice(0, 200)}`);

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!;

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const slice = raw.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch (err) {
          throw new Error(`Model response was not valid JSON: ${(err as Error).message}`);
        }
      }
    }
  }

  // Unbalanced braces almost always mean the completion hit its token ceiling
  // mid-object. Say so, because "invalid JSON" sends the reader looking for a
  // syntax error that is not there.
  throw new Error(
    'Model response ended mid-JSON — the reply was probably cut off by the token limit. Try a shorter, more specific request.',
  );
}
