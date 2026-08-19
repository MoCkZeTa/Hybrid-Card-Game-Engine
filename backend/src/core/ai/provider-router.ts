/**
 * Reads `LLM_PROVIDER` and builds the corresponding `LLMProvider`. This one
 * function is the entire "router" — everything upstream just calls
 * `decide()` on whatever it returns.
 */

import { GroqProvider, maxTokensFor } from './groq-provider.js';
import { GeminiProvider } from './gemini-provider.js';
import type { LLMProvider } from './provider.js';
import type { BotLevel } from '@hcg/shared';

export interface RouterEnv {
  readonly LLM_PROVIDER?: string;
  /** Comma- or newline-separated pool of Groq keys; calls round-robin across them. */
  readonly GROQ_API_KEYS?: string;
  /** Single-key form. Still honoured, and merged with `GROQ_API_KEYS` if both are set. */
  readonly GROQ_API_KEY?: string;
  readonly GROQ_MODEL?: string;
  /** Only sent to Groq for reasoning-capable models (e.g. `openai/gpt-oss-120b`) — see GroqProviderOptions. */
  readonly GROQ_REASONING_EFFORT?: string;
  readonly GEMINI_API_KEY?: string;
  readonly GEMINI_MODEL?: string;
}

function asReasoningEffort(value: string | undefined): 'low' | 'medium' | 'high' | undefined {
  return value === 'low' || value === 'medium' || value === 'high' ? value : undefined;
}

/**
 * Collects the Groq key pool. Accepts one key per line or comma-separated (a
 * dotenv value can span lines only if quoted, so both forms are supported),
 * and de-duplicates so pasting the same key twice doesn't make the round-robin
 * lean on it.
 */
function collectGroqKeys(env: RouterEnv): string[] {
  const raw = [env.GROQ_API_KEYS ?? '', env.GROQ_API_KEY ?? ''].join(',');
  return [...new Set(raw.split(/[,\s]+/).map((k) => k.trim()).filter(Boolean))];
}

export function createProviderFromEnv(env: RouterEnv): LLMProvider {
  const selected = (env.LLM_PROVIDER ?? 'groq').toLowerCase();

  switch (selected) {
    case 'groq':
      return new GroqProvider({
        apiKeys: collectGroqKeys(env),
        model: env.GROQ_MODEL ?? 'llama-3.1-8b-instant',
        reasoningEffort: asReasoningEffort(env.GROQ_REASONING_EFFORT),
      });
    case 'gemini':
      return new GeminiProvider({
        apiKey: env.GEMINI_API_KEY ?? '',
        model: env.GEMINI_MODEL ?? 'gemini-2.0-flash',
      });
    default:
      throw new Error(`Unknown LLM_PROVIDER "${selected}" — expected "groq" or "gemini"`);
  }
}

// ---- Bot difficulty levels --------------------------------------------------

/**
 * `reasoning_effort` value each `BotLevel` sends to Groq — `easy` omits it
 * entirely (plain fast decode), the rest step up through Groq's own
 * low/medium/high scale. Note this is only honoured by reasoning-capable
 * Groq models (`GroqProviderOptions`'s own doc comment, e.g.
 * `openai/gpt-oss-120b`); a plain chat model like the `.env.example` default
 * rejects the field with a 400 for anything above `easy`, and that turn
 * degrades to `legal_moves[0]` via `decide.ts`'s existing fallback — not a
 * crash, just a bot that skips reasoning it was never able to do.
 */
function reasoningEffortForLevel(level: BotLevel): 'low' | 'medium' | 'high' | undefined {
  switch (level) {
    case 'easy':
      return undefined;
    case 'medium':
      return 'low';
    case 'hard':
      return 'medium';
    case 'extreme':
      return 'high';
  }
}

/**
 * Wall-clock LLM budget per level. Fixed rather than derived from
 * `LLM_TIMEOUT_MS` (which no longer governs AI-seat turns — see
 * `match-manager.ts`), scaled proportionally to `maxTokensFor`'s own
 * existing 500/1400/2200/3500 token-budget ratios and anchored so `extreme`
 * lands near 10s: a harder level's hidden chain-of-thought needs
 * proportionally more time or it never finishes before `decide.ts` gives up
 * and falls back to `legal_moves[0]`.
 */
function timeoutMsForLevel(level: BotLevel): number {
  switch (level) {
    case 'easy':
      return 1500;
    case 'medium':
      return 4000;
    case 'hard':
      return 6300;
    case 'extreme':
      return 10_000;
  }
}

const BOT_LEVELS: readonly BotLevel[] = ['easy', 'medium', 'hard', 'extreme'];

/** Maps `GROQ_REASONING_EFFORT`'s existing scale onto a `BotLevel`, so a host who never touches the picker gets today's exact behavior. */
function defaultBotLevelFromEnv(env: RouterEnv): BotLevel {
  switch (asReasoningEffort(env.GROQ_REASONING_EFFORT)) {
    case 'low':
      return 'medium';
    case 'medium':
      return 'hard';
    case 'high':
      return 'extreme';
    default:
      return 'easy';
  }
}

export interface BotTier {
  readonly provider: LLMProvider;
  readonly llmTimeoutMs: number;
}

/**
 * Builds one `LLMProvider` per `BotLevel`. For Groq, four instances sharing
 * the configured model/keys that differ only by `reasoning_effort`. For
 * Gemini (no reasoning-effort knob), one shared instance across all four
 * levels — quality separation by level is a Groq-only capability for now.
 */
export function createBotTiersFromEnv(env: RouterEnv): { tiers: Record<BotLevel, BotTier>; defaultLevel: BotLevel } {
  const selected = (env.LLM_PROVIDER ?? 'groq').toLowerCase();
  const defaultLevel = defaultBotLevelFromEnv(env);
  const tiers = {} as Record<BotLevel, BotTier>;

  switch (selected) {
    case 'groq': {
      const apiKeys = collectGroqKeys(env);
      const model = env.GROQ_MODEL ?? 'llama-3.1-8b-instant';
      for (const level of BOT_LEVELS) {
        tiers[level] = {
          provider: new GroqProvider({ apiKeys, model, reasoningEffort: reasoningEffortForLevel(level) }),
          llmTimeoutMs: timeoutMsForLevel(level),
        };
      }
      break;
    }
    case 'gemini': {
      const provider = new GeminiProvider({
        apiKey: env.GEMINI_API_KEY ?? '',
        model: env.GEMINI_MODEL ?? 'gemini-2.0-flash',
      });
      for (const level of BOT_LEVELS) {
        tiers[level] = { provider, llmTimeoutMs: timeoutMsForLevel(level) };
      }
      break;
    }
    default:
      throw new Error(`Unknown LLM_PROVIDER "${selected}" — expected "groq" or "gemini"`);
  }

  return { tiers, defaultLevel };
}
