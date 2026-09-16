/**
 * Reads `LLM_PROVIDER` and builds the corresponding `LLMProvider`. This one
 * function is the entire "router" — everything upstream just calls
 * `decide()` on whatever it returns.
 */

import { GroqProvider, maxTokensFor } from './groq-provider.js';
import { GeminiProvider } from './gemini-provider.js';
import { UnconfiguredProvider, type LLMCompletionProvider, type LLMProvider } from './provider.js';
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
  /**
   * Model used by the game designer (`core/authoring/`), which authors a whole
   * rules.json rather than picking one move. Separate from `GROQ_MODEL` on
   * purpose: the game seat wants the fastest model that can pick from a list,
   * and drafting a plugin wants the most capable one available. Defaults per
   * provider in `createDesignerProviderFromEnv`.
   */
  readonly DESIGNER_MODEL?: string;
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

/**
 * How much of the hand's completed-trick history a level is shown, as a
 * fraction of the tricks played so far (see `compilePrompt`).
 *
 * Thinking time alone is a weak difficulty lever: nobody loses a hand of 29
 * because they deliberated for 1.5 seconds instead of 10, they lose because
 * they forgot both Jacks had already fallen. Memory is what actually separates
 * a weak card player from a strong one, so restricting it produces a bot that
 * plays like an inattentive human rather than one making deliberate mistakes —
 * every move it picks is still the best move for what it knows.
 *
 * It also costs nothing where there is no budget for it: `easy` has the
 * tightest timeout (1500ms) and gets no history, `extreme` has the loosest
 * (10s) and gets all of it. And unlike `reasoning_effort` — which is Groq-only,
 * and which a non-reasoning model rejects outright — trimming a prompt works
 * on every provider, so this is the one lever that also separates the levels
 * under Gemini.
 *
 * Scaled against tricks *played* rather than hand size, so the levels converge
 * early in a hand (when there is nothing yet to remember) and diverge late
 * (when recall decides the hand).
 */
function memoryFractionForLevel(level: BotLevel): number {
  switch (level) {
    case 'easy':
      // No memory at all, mirroring how `easy` omits `reasoning_effort`
      // entirely rather than sending a low value.
      return 0;
    case 'medium':
      return 0.25;
    case 'hard':
      return 0.6;
    case 'extreme':
      return 1;
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
  /**
   * Fraction of this hand's completed tricks the bot is shown, 0..1. See
   * `memoryFractionForLevel`.
   */
  readonly memoryFraction: number;
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
      // No keys is a degraded server, not a broken one: every AI turn falls
      // back to `legal_moves[0]` and the game is still playable. Letting
      // GroqProvider's constructor throw here instead killed the boot outright,
      // which contradicted both `config/env.ts` (it rates this non-fatal) and
      // the promise that an empty `.env` runs.
      for (const level of BOT_LEVELS) {
        tiers[level] = {
          provider:
            apiKeys.length > 0
              ? new GroqProvider({ apiKeys, model, reasoningEffort: reasoningEffortForLevel(level) })
              : new UnconfiguredProvider('groq', 'no GROQ_API_KEYS / GROQ_API_KEY configured'),
          llmTimeoutMs: timeoutMsForLevel(level),
          memoryFraction: memoryFractionForLevel(level),
        };
      }
      break;
    }
    case 'gemini': {
      const geminiKey = env.GEMINI_API_KEY?.trim() ?? '';
      const provider: LLMProvider = geminiKey
        ? new GeminiProvider({ apiKey: geminiKey, model: env.GEMINI_MODEL ?? 'gemini-2.0-flash' })
        : new UnconfiguredProvider('gemini', 'no GEMINI_API_KEY configured');
      for (const level of BOT_LEVELS) {
        // One shared provider — Gemini has no reasoning-effort knob — but the
        // memory ladder still differentiates the four levels here, since it is
        // a prompt-content limit rather than a provider capability.
        tiers[level] = {
          provider,
          llmTimeoutMs: timeoutMsForLevel(level),
          memoryFraction: memoryFractionForLevel(level),
        };
      }
      break;
    }
    default:
      throw new Error(`Unknown LLM_PROVIDER "${selected}" — expected "groq" or "gemini"`);
  }

  return { tiers, defaultLevel };
}

// ---- Game designer ----------------------------------------------------------

/**
 * Default drafting model per provider. Deliberately *not* `GROQ_MODEL`'s
 * default (`llama-3.1-8b-instant`): an 8B model can reliably pick one id out of
 * a list of twelve, and cannot reliably author a hundred-line schema-conformant
 * document. Picking the small model here would make the feature look broken
 * rather than look slow.
 *
 * `openai/gpt-oss-120b` is the reasoning-capable Groq model this codebase
 * already names elsewhere (see `GroqProviderOptions`), which makes it the one
 * safe assumption about what a key for this project can reach. Override with
 * `DESIGNER_MODEL` for an account with something better — a wrong guess here
 * surfaces as a clean 404 from the drafting call, not a broken boot.
 */
const DEFAULT_DESIGNER_MODEL: Readonly<Record<string, string>> = {
  groq: 'openai/gpt-oss-120b',
  gemini: 'gemini-2.0-flash',
};

/**
 * Either the provider the designer will draft with, or the reason there isn't
 * one.
 *
 * Unlike every other optional dependency in this server, the designer has no
 * useful degraded mode. A missing Mongo falls back to memory and a missing key
 * falls back to `legal_moves[0]`, but "author a card game with no language
 * model" has no fallback at all — so this reports unavailability up front and
 * the UI hides the feature, rather than offering a button that always fails.
 */
export type DesignerProviderResult =
  | { readonly available: true; readonly provider: LLMCompletionProvider }
  | { readonly available: false; readonly reason: string };

export function createDesignerProviderFromEnv(env: RouterEnv): DesignerProviderResult {
  const selected = (env.LLM_PROVIDER ?? 'groq').toLowerCase();
  const model = env.DESIGNER_MODEL?.trim() || DEFAULT_DESIGNER_MODEL[selected];

  switch (selected) {
    case 'groq': {
      const apiKeys = collectGroqKeys(env);
      if (apiKeys.length === 0) {
        return { available: false, reason: 'no GROQ_API_KEYS / GROQ_API_KEY configured' };
      }
      // No `reasoningEffort`: that knob is the bot-difficulty ladder, and a
      // game being drafted has no difficulty. See `GroqProvider.complete`.
      return { available: true, provider: new GroqProvider({ apiKeys, model: model! }) };
    }
    case 'gemini': {
      const apiKey = env.GEMINI_API_KEY?.trim() ?? '';
      if (!apiKey) return { available: false, reason: 'no GEMINI_API_KEY configured' };
      return { available: true, provider: new GeminiProvider({ apiKey, model: model! }) };
    }
    default:
      return { available: false, reason: `unknown LLM_PROVIDER "${selected}"` };
  }
}
