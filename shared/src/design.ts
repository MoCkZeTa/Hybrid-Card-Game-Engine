/**
 * Wire types for the AI game designer (the "describe a game, get a plugin"
 * flow). Lives in `shared/` because both halves of the feature speak it: the
 * backend produces these shapes and the browser renders them.
 *
 * The designer is a *drafting* tool, not a second way into the catalog. Every
 * draft it produces is ordinary `rules.json` + `strategy.md` content, and the
 * only way one becomes a real game is the same `PluginManager` write path an
 * uploaded file takes. That is deliberate: an LLM is allowed to author content,
 * never to bypass the gate that content is checked at.
 *
 * Keep this file dependency-free, like every other module in `shared/`.
 */

/**
 * One candidate plugin. `rules` is deliberately `unknown` rather than
 * `RulesDsl` — a draft is shown to the user *whether or not it validates*, and
 * typing it as valid would be a lie the compiler would then help us tell.
 */
export interface DesignDraft {
  readonly rules: unknown;
  readonly strategy: string;
}

export type DesignSeverity = 'error' | 'warning';

/**
 * `error` means the draft cannot be published as-is: either `validateRulesDsl`
 * rejected it or the engine could not play a hand of it. `warning` means it
 * plays, but something about it is probably not what the author meant (a
 * scoring field that the chosen formula ignores, a table size that deals zero
 * cards to somebody).
 */
export interface DesignDiagnostic {
  readonly severity: DesignSeverity;
  readonly message: string;
}

export interface DesignDiagnostics {
  /** True when there are no `error`-severity diagnostics — i.e. publishable. */
  readonly valid: boolean;
  /** Whether a real match of these rules was dealt, played and scored. */
  readonly playable: boolean;
  readonly diagnostics: readonly DesignDiagnostic[];
}

/**
 * One turn of the design conversation: what the author asked for, what came
 * back, and what was wrong with it. Revisions are append-only — reverting
 * doesn't delete anything, it appends the older draft as a new revision — so
 * the history is always a straight line the author can read top to bottom.
 */
export interface DesignRevision {
  /** 1-based, and stable: revision 3 is always revision 3. */
  readonly n: number;
  /** The author's own words for this turn. Empty for a revert. */
  readonly prompt: string;
  readonly draft: DesignDraft;
  /** The model's one-line account of what it changed. */
  readonly summary: string;
  /**
   * Things the model chose to flag: a rule it could not express in the DSL, an
   * assumption it made about an ambiguous brief. This is the honest-reporting
   * channel — a designer that silently drops half a request is worse than one
   * that says which half it dropped.
   */
  readonly notes: readonly string[];
  readonly diagnostics: DesignDiagnostics;
  /**
   * How many times the draft had to be sent back to the model with its own
   * validation errors before it passed. 0 means it was right first time.
   */
  readonly repairAttempts: number;
  readonly createdAt: string;
}

export interface DesignSessionSummary {
  readonly sessionId: string;
  /** Derived from the first brief; shown in the session list. */
  readonly title: string;
  readonly revisionCount: number;
  /** Set once the session has been published, so re-publishing updates that game. */
  readonly publishedGameId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DesignSessionDetail extends DesignSessionSummary {
  readonly revisions: readonly DesignRevision[];
}

/**
 * Answered by `GET /api/design` before the UI offers the feature. The designer
 * needs a *generative* LLM call, not the bounded move-pick the game loop makes,
 * so it is the one part of this server with no meaningful degraded mode: with
 * no API key there is nothing to fall back to. Reporting that up front beats an
 * "Ask AI" button that always fails.
 */
export interface DesignAvailability {
  readonly available: boolean;
  /** Human-readable cause when unavailable, e.g. which env var is missing. */
  readonly reason?: string;
  /** Provider + model actually used for drafting, for the UI's footer. */
  readonly model?: string;
}
