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
