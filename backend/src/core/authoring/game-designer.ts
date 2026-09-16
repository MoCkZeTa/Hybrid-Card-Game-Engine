/**
 * Turns a description of a card game into a `rules.json` + `strategy.md` pair.
 *
 * The shape of this is deliberately the authoring-time mirror of
 * `core/ai/decide.ts`. That file's whole discipline is that the model's output
 * is never trusted on its own: the engine produces a bounded set, the model
 * picks from it, and anything outside the set falls back to a known-good
 * answer. Authoring cannot bound the output set — a rules.json is not a choice
 * from a list — so the equivalent guarantee is built the other way round:
 *
 *   1. The model is shown the exact schema and told what is NOT expressible
 *      (`dsl-reference.ts`), so it has no reason to invent vocabulary.
 *   2. Whatever comes back is validated AND actually played by the engine
 *      (`draft-validator.ts`).
 *   3. Failures are handed back to the model verbatim, up to a bounded number
 *      of repair attempts. This is where most of the quality comes from: a
 *      model that gets "no legal move exists in phase BIDDING for seat 0" fixes
 *      it nearly every time, and would never have found it unaided.
 *   4. If it still doesn't validate, the draft is returned anyway, with its
 *      diagnostics attached. The author sees what was produced and what is
 *      wrong with it, and can edit it by hand or ask again — which is strictly
 *      better than an error message and no draft.
 *
 * Nothing here can publish. A draft becomes a game only by going through
 * `PluginManager`, the same gate an uploaded file passes.
 */

import {
  extractJsonObject,
  type LLMCompletionProvider,
} from '../ai/provider.js';
import type { DesignDiagnostics, DesignDraft } from '@hcg/shared';
import { validateDraft } from './draft-validator.js';
import { DSL_EXAMPLE, DSL_LIMITATIONS, DSL_REFERENCE, STRATEGY_GUIDE_BRIEF } from './dsl-reference.js';

/**
 * Token budget for one drafting call. A rules.json runs 800-1800 tokens and a
 * strategy.md another 700-1400, so the visible answer is ~3000 at the top end.
 * The rest of this budget is headroom for a reasoning model's hidden
 * chain-of-thought, which is spent from the same allowance before a single
 * character of JSON is emitted — and the failure mode of running out is a
 * response truncated mid-object, which costs a whole round trip to discover.
 * A ceiling is not free, though, and that is the trap: Groq bills `max_tokens`
 * against the per-minute token budget up front, whether or not the completion
 * uses it — so an over-generous ceiling is refused outright with a 413 on a
 * free-tier key rather than merely going unused. 8000 clears the visible answer
 * with room for moderate hidden reasoning, and `DESIGNER_MAX_TOKENS` exists for
 * accounts whose limit is tighter still.
 */
const DEFAULT_MAX_TOKENS = 8000;

/**
 * Wall-clock budget for one call. Far longer than any game-seat timeout
 * (`provider-router.ts` caps the hardest bot at 10s) because the tradeoff is
 * inverted: a slow AI turn stalls a live table, while a slow draft is a person
 * watching a spinner having explicitly asked for something that takes a while.
 */
const DEFAULT_TIMEOUT_MS = 90_000;

/**
 * How many times a failing draft is sent back with its own errors. Two is the
 * point of diminishing returns in practice: the first repair fixes nearly
 * everything mechanical, the second catches an error the first introduced, and
 * a model that is still wrong on the third pass is wrong about the game rather
 * than about the schema — at which point returning the draft with its
 * diagnostics beats burning more of the author's time and the account's quota.
 */
const DEFAULT_MAX_REPAIR_ATTEMPTS = 2;

/**
 * Hard caps on model-authored content, applied before anything is stored.
 *
 * `strategy.md` is injected verbatim into the system prompt of the model that
 * plays the AI seats, so it is untrusted text on a path into another prompt.
 * The zero-hallucination contract already contains the damage — that model can
 * only return one id from a bounded list, and `decide.ts` discards anything
 * outside it — so the risk here is cost and context exhaustion rather than
 * hijacking. A cap covers both.
 */
const MAX_STRATEGY_CHARS = 24_000;
const MAX_RULES_CHARS = 32_000;
/** Per-note and per-summary caps, since these are rendered straight into the UI. */
const MAX_NOTE_CHARS = 400;
const MAX_NOTES = 12;

export interface DesignerOptions {
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
  readonly maxRepairAttempts?: number;
}

export interface DesignRequest {
  /** What the author asked for this turn, in their own words. */
  readonly brief: string;
  /**
   * The draft being refined. Absent for the first turn of a session, which is
   * what makes this "design a new game" rather than "change this game".
   */
  readonly prior?: DesignDraft;
  /**
   * Earlier briefs in this session, oldest first. Carried so a later
   * instruction like "actually, make it three players" is read against what
   * was already asked for rather than in isolation. Only the briefs, never the
   * intermediate drafts — the current draft already encodes those, and
   * replaying every version would blow the context window on a long session.
   */
  readonly history?: readonly string[];
}

export interface DesignResult {
  readonly draft: DesignDraft;
  /** The model's one-line account of what it did. */
  readonly summary: string;
  /** What it could not express, or assumed. See `DSL_LIMITATIONS`. */
  readonly notes: readonly string[];
  readonly diagnostics: DesignDiagnostics;
  readonly repairAttempts: number;
}

/** A drafting call that produced nothing usable at all — no JSON, or no rules key. */
export class DesignError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DesignError';
  }
}

export class GameDesigner {
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly maxRepairAttempts: number;

  constructor(
    private readonly provider: LLMCompletionProvider,
    opts: DesignerOptions = {},
  ) {
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRepairAttempts = opts.maxRepairAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS;
  }

  /** Provider and model actually drafting, for the UI footer and the logs. */
  get modelLabel(): string {
    return `${this.provider.name}/${this.provider.model}`;
  }

  async design(request: DesignRequest): Promise<DesignResult> {
    // A first draft has to author the strategy guide; a refine only does when
    // the instruction is about it. Everything else carries the existing guide
    // forward untouched — see `outputContract`.
    const mode = request.prior ? 'refine' : 'create';
    const includeStrategy = mode === 'create' || briefConcernsStrategy(request.brief);
    const systemPrompt = buildSystemPrompt(mode, includeStrategy);
    /** What a response omitting `strategy` inherits. Empty on a first draft, which must supply one. */
    const carriedStrategy = includeStrategy ? undefined : request.prior?.strategy;

    let userPrompt = buildUserPrompt(request);
    let last: ParsedDraft | null = null;
    let lastDiagnostics: DesignDiagnostics | null = null;

    for (let attempt = 0; attempt <= this.maxRepairAttempts; attempt++) {
      const raw = await this.callModel(systemPrompt, userPrompt);
      const parsed = parseDesignResponse(raw, carriedStrategy);
      const diagnostics = validateDraft(parsed.draft.rules, parsed.draft.strategy);

      if (diagnostics.valid) {
        return {
          draft: parsed.draft,
          summary: parsed.summary,
          notes: parsed.notes,
          diagnostics,
          repairAttempts: attempt,
        };
      }

      last = parsed;
      lastDiagnostics = diagnostics;
      // Repair prompts carry the whole failing draft rather than a diff: a
      // model asked to patch JSON it cannot see reliably re-emits the parts it
      // is guessing at, and reintroduces the very field it was told to fix.
      userPrompt = buildRepairPrompt(request, parsed, diagnostics);
    }

    // Out of attempts. Hand back the last draft with its diagnostics — the
    // author can see exactly what was produced and what is wrong with it,
    // which beats an error and an empty editor.
    return {
      draft: last!.draft,
      summary: last!.summary,
      notes: last!.notes,
      diagnostics: lastDiagnostics!,
      repairAttempts: this.maxRepairAttempts,
    };
  }

  private async callModel(systemPrompt: string, userPrompt: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.provider.complete({
        systemPrompt,
        userPrompt,
        signal: controller.signal,
        maxTokens: this.maxTokens,
        temperature: 0.4,
        json: true,
      });
    } catch (err) {
      // An abort surfaces as a generic DOMException, which reads like a bug
      // rather than a budget. Name the actual cause.
      if (controller.signal.aborted) {
        throw new DesignError(
          `The model did not answer within ${Math.round(this.timeoutMs / 1000)}s. Try a shorter description, or ask for one change at a time.`,
        );
      }
      throw new DesignError((err as Error).message);
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * What the model is shown, sized to the job in front of it.
 *
 * Context is neither free nor neutral here. The reference alone is ~3700
 * tokens, and Groq charges the reply ceiling against the *same* per-minute
 * budget as the prompt — so on a modest tier the two together decide whether
 * the request is answered at all, which makes "send everything every time" a
 * real cost rather than a safe default.
 *
 * It is also weaker prompting. On a refine the model is holding a valid
 * document it wrote: the worked example teaches it nothing it cannot read off
 * its own draft, and the strategy-guide brief is dead weight unless the guide
 * is what is being changed. Sending them anyway dilutes the one instruction
 * that matters — the one the author just typed.
 */
function buildSystemPrompt(mode: 'create' | 'refine', includeStrategy: boolean): string {
  const parts = [
    `You are a card game designer for a plugin-driven trick-taking engine. You
translate a description of a card game into two artifacts: a rules.json
conforming exactly to the DSL below, and a strategy.md guide.

The engine runs your rules.json as data. There is no code to write and no
escape hatch: anything the DSL cannot express, the game will not do. A field
you invent is not an extension — it is ignored, and the resulting game plays
differently from what was asked for without saying so.`,
    DSL_REFERENCE,
    DSL_LIMITATIONS,
  ];

  // The worked example anchors the shape for a model starting from nothing. On
  // a refine, its own current draft is a better and more relevant example.
  if (mode === 'create') parts.push(DSL_EXAMPLE);
  if (includeStrategy) parts.push(STRATEGY_GUIDE_BRIEF);
  parts.push(outputContract(includeStrategy));

  return parts.join('\n\n');
}

/**
 * The response envelope. The `strategy` half is conditional: when the guide is
 * being carried forward unchanged, asking for it back would spend ~1400 tokens
 * of reply budget receiving a copy of something already held — and every
 * regeneration is a chance to quietly degrade a guide the author was happy
 * with. Omission is the safer default, so it is made the explicit instruction.
 */
function outputContract(includeStrategy: boolean): string {
  const strategyLine = includeStrategy
    ? ',\n  "strategy": "the complete strategy.md, as a markdown string"'
    : '';
  const strategyRule = includeStrategy
    ? '- "strategy" is a single JSON string; escape newlines as \\n.'
    : `- Do NOT include a "strategy" key. The existing strategy.md is kept as it is.
  If your change to the rules makes the existing guide wrong, say so in "notes"
  rather than rewriting it here.`;

  return `## Your output

Reply with ONE JSON object and nothing else — no prose before it, no markdown
fence around it:

{
  "summary": "one sentence, past tense, describing what you produced or changed",
  "notes": ["anything you could not express, assumed, or simplified — one item each"],
  "rules": { ...the complete rules.json object... }${strategyLine}
}

Rules for your output:
- "rules" is the complete document every time, never a patch or a fragment.
- Do NOT include a "gameId" key anywhere.
${strategyRule}
- Put every caveat in "notes". An empty array means you expressed the game
  faithfully and completely — do not claim that unless it is true.
- If the description is ambiguous, choose the most standard interpretation of
  that game, state the choice in "notes", and produce a complete draft anyway.
  Never reply asking a question instead of drafting.`;
}

/**
 * Whether this turn is about the strategy guide rather than the rules.
 *
 * A keyword test, deliberately. A false positive costs one larger prompt; a
 * false negative means the author asks for better bots and is told the rules
 * are unchanged. Erring toward including it is the cheap direction, so the
 * pattern is broad.
 */
export function briefConcernsStrategy(brief: string): boolean {
  return /strateg|guide|\bbots?\b|\bai\b|heuristic|tactic|play(s|ing)? (better|worse|well)/i.test(brief);
}

function buildUserPrompt(request: DesignRequest): string {
  const parts: string[] = [];

  if (request.history?.length) {
    parts.push(
      `Earlier instructions in this session, oldest first (the current draft already reflects these):\n${request.history
        .map((h, i) => `${i + 1}. ${h}`)
        .join('\n')}`,
    );
  }

  if (request.prior) {
    const rulesJson = JSON.stringify(request.prior.rules, null, 2);
    // The guide is shown only when the turn is about it. Otherwise it is
    // carried forward server-side and the model is told so, rather than left to
    // infer that its absence means "deleted".
    const strategySection = briefConcernsStrategy(request.brief)
      ? `\n\nCurrent strategy.md:\n${request.prior.strategy}`
      : `\n\nThe strategy.md guide is unchanged and is not shown here; it is kept exactly as it is.`;

    parts.push(
      `Here is the current draft. Change only what the new instruction asks for and keep everything else exactly as it is.\n\nCurrent rules.json:\n${rulesJson}${strategySection}`,
    );
    parts.push(`New instruction:\n${request.brief}`);
  } else {
    parts.push(`Design this game:\n${request.brief}`);
  }

  return parts.join('\n\n---\n\n');
}

/**
 * The repair turn. Phrased as a report of what the engine did, not as a
 * scolding — the messages are the validator's own strings, which name the
 * phase and seat where play stopped, and that specificity is what makes the
 * fix reliable.
 */
function buildRepairPrompt(
  request: DesignRequest,
  parsed: ParsedDraft,
  diagnostics: DesignDiagnostics,
): string {
  const errors = diagnostics.diagnostics.filter((d) => d.severity === 'error');
  return [
    `Your draft was rejected. The engine ${
      diagnostics.playable
        ? 'validated the document but found problems with it'
        : 'could not deal and play a match with it'
    }:`,
    errors.map((e) => `- ${e.message}`).join('\n'),
    `Here is the draft that failed:\n\nrules.json:\n${JSON.stringify(parsed.draft.rules, null, 2)}`,
    `Fix every problem listed above and reply with the same JSON object shape as before, containing the COMPLETE corrected rules.json and strategy.md. Do not change anything that was not part of a listed problem.`,
    `For reference, the original request was:\n${request.brief}`,
  ].join('\n\n');
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

interface ParsedDraft {
  readonly draft: DesignDraft;
  readonly summary: string;
  readonly notes: readonly string[];
}

/**
 * Reads the model's envelope. Everything here treats the response as hostile
 * input rather than as a value of a known type: it is JSON from an external
 * service, and the difference between "the model omitted `notes`" and a crash
 * in a route handler is exactly this function.
 *
 * Exported for the tests, which drive it with the malformed shapes real models
 * actually produce.
 */
export function parseDesignResponse(raw: string, carriedStrategy?: string): ParsedDraft {
  const parsed = extractJsonObject(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new DesignError('The model did not return a JSON object.');
  }
  const obj = parsed as Record<string, unknown>;

  if (obj.rules === undefined || obj.rules === null) {
    throw new DesignError('The model returned a response with no "rules" object in it.');
  }

  // A model that is told not to emit an id emits one occasionally anyway.
  // `validateRulesDsl` rejects it outright — which is right for a human author
  // who needs to learn that identity is the server's — but spending a repair
  // attempt teaching a model the same lesson is waste. Strip it instead; the
  // author never asked for it and there is nothing here to correct.
  const rules = stripGameId(obj.rules);

  const rulesJson = JSON.stringify(rules);
  if (rulesJson.length > MAX_RULES_CHARS) {
    throw new DesignError(`The generated rules.json is implausibly large (${rulesJson.length} characters).`);
  }

  // On a rules-only refine the model is told to omit `strategy` entirely, so an
  // absent one means "unchanged" rather than "empty" — and `carriedStrategy`
  // supplies what it stands for. A model that ignores the instruction and sends
  // a guide anyway is taken at its word; both paths still go through
  // `validateDraft`, which treats a genuinely empty guide as an error.
  const authored = typeof obj.strategy === 'string' ? obj.strategy.trim() : '';
  const strategy = authored ? authored.slice(0, MAX_STRATEGY_CHARS) : (carriedStrategy ?? '');

  return {
    draft: { rules, strategy },
    summary: typeof obj.summary === 'string' ? obj.summary.slice(0, MAX_NOTE_CHARS) : 'Draft updated.',
    notes: Array.isArray(obj.notes)
      ? obj.notes
          .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
          .slice(0, MAX_NOTES)
          .map((n) => n.slice(0, MAX_NOTE_CHARS))
      : [],
  };
}

/** Drops a top-level `gameId` if the model emitted one. See `parseDesignResponse`. */
function stripGameId(rules: unknown): unknown {
  if (typeof rules !== 'object' || rules === null || Array.isArray(rules)) return rules;
  if (!('gameId' in rules)) return rules;
  const { gameId: _dropped, ...rest } = rules as Record<string, unknown>;
  return rest;
}
