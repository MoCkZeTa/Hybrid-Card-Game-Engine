/**
 * Persistence for design sessions — the conversation that produces a plugin.
 *
 * Follows the same `InMemory*` / `Mongo*` behind-one-interface shape as
 * `PluginRepository`, `MatchRepository` and `UserRepository`, and for the same
 * reason: a session is user data, and a node's local disk is the wrong home
 * for it. A designer who spends ten minutes refining a game across four
 * revisions should not lose that because the process restarted or because a
 * load balancer sent their next request to a different node.
 *
 * Like `PluginRepository`, **the store assigns the id** — nothing a caller
 * supplies becomes a session identity.
 */

import { randomUUID } from 'node:crypto';
import type { DesignRevision } from '@hcg/shared';

/**
 * Revisions kept per session. Each is a full draft (~8-12 KB of JSON), so this
 * bounds a session document well under Mongo's 16 MB limit while being far more
 * history than anyone iterates through in practice. Beyond it the oldest are
 * dropped, and `n` keeps counting up — revision numbers are stable identifiers,
 * not array indices, so renumbering to close the gap would silently change what
 * "revert to 3" means.
 */
export const MAX_REVISIONS_PER_SESSION = 40;

/**
 * Sessions kept per user. A cap rather than unbounded growth because each one
 * is a durable document created by a single button press; without it, an
 * automated client could fill the collection. High enough that no real author
 * meets it before they would want to tidy up anyway.
 */
export const MAX_SESSIONS_PER_USER = 50;

export interface DesignSession {
  /** Assigned by the repository on `create`; never supplied by a caller. */
  readonly sessionId: string;
  readonly ownerUserId: string;
  readonly title: string;
  readonly revisions: readonly DesignRevision[];
  /**
   * The game this session has been published as, if any. Set on first publish
   * so a later one updates that same game rather than littering the catalog
   * with a new copy per revision.
   */
  readonly publishedGameId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A session's content, without the identity the store has yet to assign. */
export type DesignSessionContent = Omit<DesignSession, 'sessionId'>;

export interface DesignSessionRepository {
  create(session: DesignSessionContent): Promise<DesignSession>;
  /** Replaces an existing session's content in place. No-op if the id is unknown. */
  update(sessionId: string, session: DesignSessionContent): Promise<void>;
  findById(sessionId: string): Promise<DesignSession | null>;
  /** Newest first — the order the session list is rendered in. */
  findByOwner(ownerUserId: string): Promise<DesignSession[]>;
  countByOwner(ownerUserId: string): Promise<number>;
  delete(sessionId: string): Promise<void>;
}

/**
 * Appends a revision, enforcing `MAX_REVISIONS_PER_SESSION`. Shared by both
 * implementations (and by the route layer) so the trimming rule cannot differ
 * between a Mongo deployment and an in-memory one.
 */
export function appendRevision(
  revisions: readonly DesignRevision[],
  revision: DesignRevision,
): readonly DesignRevision[] {
  const next = [...revisions, revision];
  return next.length > MAX_REVISIONS_PER_SESSION ? next.slice(next.length - MAX_REVISIONS_PER_SESSION) : next;
}

/** The number a newly appended revision gets: one past the highest ever used. */
export function nextRevisionNumber(revisions: readonly DesignRevision[]): number {
  return revisions.length === 0 ? 1 : revisions[revisions.length - 1]!.n + 1;
}

export class InMemoryDesignSessionRepository implements DesignSessionRepository {
  private readonly store = new Map<string, DesignSession>();

  async create(session: DesignSessionContent): Promise<DesignSession> {
    const stored: DesignSession = { ...session, sessionId: randomUUID() };
    this.store.set(stored.sessionId, stored);
    return stored;
  }

  async update(sessionId: string, session: DesignSessionContent): Promise<void> {
    if (!this.store.has(sessionId)) return;
    this.store.set(sessionId, { ...session, sessionId });
  }

  async findById(sessionId: string): Promise<DesignSession | null> {
    return this.store.get(sessionId) ?? null;
  }

  async findByOwner(ownerUserId: string): Promise<DesignSession[]> {
    return [...this.store.values()]
      .filter((s) => s.ownerUserId === ownerUserId)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  async countByOwner(ownerUserId: string): Promise<number> {
    let count = 0;
    for (const session of this.store.values()) if (session.ownerUserId === ownerUserId) count++;
    return count;
  }

  async delete(sessionId: string): Promise<void> {
    this.store.delete(sessionId);
  }
}
