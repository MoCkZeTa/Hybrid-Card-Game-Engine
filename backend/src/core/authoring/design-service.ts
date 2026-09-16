/**
 * The design feature's application layer: everything the HTTP routes do,
 * minus HTTP.
 *
 * Holds the three rules that matter and that no route should be trusted to
 * remember:
 *
 *  - **Ownership.** A session belongs to the user who created it, and a request
 *    for someone else's session gets the same "no such session" a nonexistent
 *    id gets — never a 403, which would confirm it exists. Same reasoning as
 *    `PluginManager.getVisible`.
 *  - **Publishing goes through `PluginManager`.** This service never writes to
 *    `PluginRepository` itself. A drafted game is validated by exactly the code
 *    that validates an uploaded file, so there is one gate rather than two that
 *    can drift.
 *  - **History is append-only.** Reverting appends the old draft as a new
 *    revision instead of truncating, so the transcript always reads straight
 *    down and nothing an author produced disappears from under them.
 */

import type { DesignDraft, DesignRevision, DesignSessionDetail, DesignSessionSummary } from '@hcg/shared';
import type { GamePlugin, PluginManager } from '../plugin/plugin-manager.js';
import { validateDraft } from './draft-validator.js';
import { GameDesigner, type DesignRequest } from './game-designer.js';
import {
  appendRevision,
  nextRevisionNumber,
  MAX_SESSIONS_PER_USER,
  type DesignSession,
  type DesignSessionRepository,
} from './design-session-repository.js';

/** No such session, or not this user's. The two are deliberately indistinguishable. */
export class DesignNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Unknown design session "${sessionId}"`);
    this.name = 'DesignNotFoundError';
  }
}

/** A per-user cap was reached. Carries a message written for the author, not the log. */
export class DesignLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DesignLimitError';
  }
}

/** A draft was asked to be published while it still has errors. */
export class DesignNotPublishableError extends Error {
  constructor(public readonly reasons: readonly string[]) {
    super(`Draft is not publishable:\n  - ${reasons.join('\n  - ')}`);
    this.name = 'DesignNotPublishableError';
  }
}

/**
 * Longest brief accepted per turn. Generous for a description of a card game
 * (a full page is ~3000 characters) while keeping a single request from
 * dominating the prompt — and, since the brief is echoed back on every later
 * turn as history, from dominating every *subsequent* request too.
 */
export const MAX_BRIEF_CHARS = 4000;

/** How many earlier briefs are replayed as context. See `DesignRequest.history`. */
const HISTORY_TURNS = 6;

export class DesignService {
  constructor(
    private readonly designer: GameDesigner,
    private readonly sessions: DesignSessionRepository,
    private readonly plugins: PluginManager,
  ) {}

  get modelLabel(): string {
    return this.designer.modelLabel;
  }

  // ---- Reads --------------------------------------------------------------

  async list(userId: string): Promise<DesignSessionSummary[]> {
    const sessions = await this.sessions.findByOwner(userId);
    return sessions.map(toSummary);
  }

  async get(sessionId: string, userId: string): Promise<DesignSessionDetail> {
    return toDetail(await this.load(sessionId, userId));
  }

  // ---- Writes -------------------------------------------------------------

  /**
   * Starts a session from a description and drafts revision 1. The draft is
   * produced *before* the session is created, so a failed generation leaves no
   * empty session behind for the author to wonder about.
   */
  async createSession(userId: string, brief: string): Promise<DesignSessionDetail> {
    const text = requireBrief(brief);

    const count = await this.sessions.countByOwner(userId);
    if (count >= MAX_SESSIONS_PER_USER) {
      throw new DesignLimitError(
        `You have ${count} saved designs, which is the maximum. Delete one you have finished with to start another.`,
      );
    }

    const result = await this.designer.design({ brief: text });
    const now = new Date();
    const revision = toRevision(1, text, result, now);

    const session = await this.sessions.create({
      ownerUserId: userId,
      title: deriveTitle(result.draft, text),
      revisions: [revision],
      publishedGameId: null,
      createdAt: now,
      updatedAt: now,
    });

    return toDetail(session);
  }

  /** One more turn of the conversation: refine the latest draft with a new instruction. */
  async refine(sessionId: string, userId: string, brief: string): Promise<DesignSessionDetail> {
    const text = requireBrief(brief);
    const session = await this.load(sessionId, userId);
    const latest = latestRevision(session);

    const request: DesignRequest = {
      brief: text,
      prior: latest.draft,
      // Oldest-first, most recent `HISTORY_TURNS` only — the current draft
      // already encodes what the earlier turns did, so this is context for
      // *intent* ("keep it a 3-player game") rather than a replay of the work.
      history: session.revisions
        .slice(-HISTORY_TURNS)
        .map((r) => r.prompt)
        .filter((p) => p.length > 0),
    };

    const result = await this.designer.design(request);
    return this.commit(session, toRevision(nextRevisionNumber(session.revisions), text, result, new Date()));
  }

  /**
   * Replaces the current draft with content the author edited by hand.
   *
   * The designer is a drafting aid, not a wall: an author who can see the JSON
   * will sometimes just fix the one field themselves rather than describe the
   * fix in English and wait for a round trip. The edit is validated by the same
   * `validateDraft` an AI turn goes through, so a hand-edit cannot smuggle in
   * something a generated draft could not.
   */
  async applyManualEdit(
    sessionId: string,
    userId: string,
    rules: unknown,
    strategy: string,
  ): Promise<DesignSessionDetail> {
    const session = await this.load(sessionId, userId);
    const draft: DesignDraft = { rules, strategy };
    const diagnostics = validateDraft(rules, strategy);

    return this.commit(session, {
      n: nextRevisionNumber(session.revisions),
      prompt: '',
      draft,
      summary: 'Edited by hand.',
      notes: [],
      diagnostics,
      repairAttempts: 0,
      createdAt: new Date().toISOString(),
    });
  }

  /**
   * Brings an earlier revision back as the current one.
   *
   * Appends rather than truncates. Undo that destroys the thing being undone
   * is only useful once — this way an author can revert to revision 2, decide
   * they preferred 5 after all, and revert again.
   */
  async revert(sessionId: string, userId: string, n: number): Promise<DesignSessionDetail> {
    const session = await this.load(sessionId, userId);
    const target = session.revisions.find((r) => r.n === n);
    if (!target) throw new DesignNotFoundError(`${sessionId}#${n}`);

    return this.commit(session, {
      ...target,
      n: nextRevisionNumber(session.revisions),
      prompt: '',
      summary: `Reverted to revision ${n}.`,
      createdAt: new Date().toISOString(),
    });
  }

  /**
   * Publishes the current draft into the game catalog.
   *
   * First publish imports (minting a new gameId); every publish after that
   * updates the same game, so iterating on a design does not leave a trail of
   * near-identical entries in the lobby. If the published game has since been
   * deleted, this falls back to importing a fresh one rather than failing —
   * the author's intent ("put this in my catalog") is satisfied either way.
   */
  async publish(sessionId: string, userId: string): Promise<{ session: DesignSessionDetail; gameId: string }> {
    const session = await this.load(sessionId, userId);
    const latest = latestRevision(session);

    // Re-validated here rather than trusting the stored verdict: the draft may
    // have been produced before a DSL change, and `PluginManager` is about to
    // apply today's rules to it regardless. Better to explain why than to let
    // it fail as an opaque import error.
    const diagnostics = validateDraft(latest.draft.rules, latest.draft.strategy);
    if (!diagnostics.valid) {
      throw new DesignNotPublishableError(
        diagnostics.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message),
      );
    }

    const plugin = await this.importOrUpdate(session, latest.draft, userId);

    await this.sessions.update(session.sessionId, {
      ...toContent(session),
      publishedGameId: plugin.gameId,
      updatedAt: new Date(),
    });

    const refreshed = await this.sessions.findById(session.sessionId);
    return { session: toDetail(refreshed ?? { ...session, publishedGameId: plugin.gameId }), gameId: plugin.gameId };
  }

  async delete(sessionId: string, userId: string): Promise<void> {
    const session = await this.load(sessionId, userId);
    // Only the session goes. A game already published from it is a real entry
    // in the author's catalog with matches potentially referencing it, and
    // deleting the notes you designed something from should never delete the
    // thing itself.
    await this.sessions.delete(session.sessionId);
  }

  // ---- Internals ----------------------------------------------------------

  private async load(sessionId: string, userId: string): Promise<DesignSession> {
    const session = await this.sessions.findById(sessionId);
    if (!session || session.ownerUserId !== userId) throw new DesignNotFoundError(sessionId);
    return session;
  }

  /** Appends a revision and persists, returning the updated session. */
  private async commit(session: DesignSession, revision: DesignRevision): Promise<DesignSessionDetail> {
    const revisions = appendRevision(session.revisions, revision);
    const updated: DesignSession = { ...session, revisions, updatedAt: new Date() };
    await this.sessions.update(session.sessionId, toContent(updated));
    return toDetail(updated);
  }

  private async importOrUpdate(
    session: DesignSession,
    draft: DesignDraft,
    userId: string,
  ): Promise<GamePlugin> {
    if (session.publishedGameId) {
      try {
        return await this.plugins.updatePlugin(session.publishedGameId, draft.rules, draft.strategy, userId);
      } catch (err) {
        // The game this session published was deleted from the catalog. Import
        // a new one rather than reporting a failure about a game the author
        // already knows they removed.
        if (!/^Unknown gameId/.test((err as Error).message)) throw err;
      }
    }
    return this.plugins.importPlugin(draft.rules, draft.strategy, userId);
  }
}

// ---------------------------------------------------------------------------
// Shape conversions
// ---------------------------------------------------------------------------

function requireBrief(brief: string): string {
  const text = brief.trim();
  if (!text) throw new DesignLimitError('Describe the game you want before asking for a draft.');
  if (text.length > MAX_BRIEF_CHARS) {
    throw new DesignLimitError(
      `That description is ${text.length} characters; the limit is ${MAX_BRIEF_CHARS}. Try describing the game more briefly, then refine it over a few turns.`,
    );
  }
  return text;
}

function latestRevision(session: DesignSession): DesignRevision {
  const latest = session.revisions[session.revisions.length - 1];
  // Unreachable: `createSession` writes revision 1 before the session exists,
  // and nothing removes the last one.
  if (!latest) throw new DesignNotFoundError(session.sessionId);
  return latest;
}

function toRevision(
  n: number,
  prompt: string,
  result: Awaited<ReturnType<GameDesigner['design']>>,
  at: Date,
): DesignRevision {
  return {
    n,
    prompt,
    draft: result.draft,
    summary: result.summary,
    notes: result.notes,
    diagnostics: result.diagnostics,
    repairAttempts: result.repairAttempts,
    createdAt: at.toISOString(),
  };
}

/**
 * The session's name in the list. The game's own `displayName` is what the
 * author will recognise; the opening brief is the fallback for a draft too
 * broken to have named itself.
 */
function deriveTitle(draft: DesignDraft, brief: string): string {
  const rules = draft.rules;
  if (typeof rules === 'object' && rules !== null) {
    const { displayName } = rules as { displayName?: unknown };
    if (typeof displayName === 'string' && displayName.trim()) return displayName.trim().slice(0, 80);
  }
  return brief.slice(0, 60).trim() || 'Untitled design';
}

function toContent(session: DesignSession): Omit<DesignSession, 'sessionId'> {
  const { sessionId: _id, ...content } = session;
  return content;
}

function toSummary(session: DesignSession): DesignSessionSummary {
  return {
    sessionId: session.sessionId,
    title: session.title,
    revisionCount: session.revisions.length,
    publishedGameId: session.publishedGameId,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  };
}

function toDetail(session: DesignSession): DesignSessionDetail {
  return { ...toSummary(session), revisions: session.revisions };
}
