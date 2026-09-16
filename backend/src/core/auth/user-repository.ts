/**
 * User, session, and password-reset storage. Interface-first so the server can
 * boot on `InMemoryUserRepository` when Mongo is unreachable, with the Mongo
 * implementation dropping in unchanged once the DB connects.
 *
 * Two design points worth keeping:
 *
 *  - **Sessions are listable per user.** Revoking one token is a delete; "sign
 *    out everywhere" and "a password change kills every other session" both
 *    need the whole set, and so does invalidating the session cache, which is
 *    keyed by token and has no idea which user a token belongs to.
 *  - **Reset tokens are stored hashed, never in plaintext.** The token in the
 *    email is a bearer credential for the account; a database dump containing
 *    live ones would be an account-takeover kit. We store SHA-256 and compare
 *    hashes, so a leaked row is worthless.
 */

export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly createdAt: Date;
}

export interface SessionRecord {
  readonly token: string;
  readonly userId: string;
  readonly expiresAt: Date;
}

/** A pending "forgot password" request. `tokenHash` is SHA-256 of the emailed token. */
export interface PasswordResetRecord {
  readonly tokenHash: string;
  readonly userId: string;
  readonly expiresAt: Date;
}

export interface UserRepository {
  findByEmail(email: string): Promise<UserRecord | null>;
  findById(id: string): Promise<UserRecord | null>;
  create(user: UserRecord): Promise<void>;
  /** Replaces the stored hash. Used by change-password, reset, and cost upgrades. */
  updatePassword(userId: string, passwordHash: string): Promise<void>;

  createSession(session: SessionRecord): Promise<void>;
  findSession(token: string): Promise<SessionRecord | null>;
  deleteSession(token: string): Promise<void>;
  /** Every live session for a user — the input to a bulk revoke and to cache invalidation. */
  findSessionsByUser(userId: string): Promise<readonly SessionRecord[]>;
  /**
   * Revokes every session for a user, optionally sparing one (the caller's own,
   * so changing your password does not sign you out of the tab you did it in).
   */
  deleteSessionsForUser(userId: string, exceptToken?: string): Promise<void>;
  /** Pushes a session's expiry out — the sliding-window renewal. */
  renewSession(token: string, expiresAt: Date): Promise<void>;

  createPasswordReset(reset: PasswordResetRecord): Promise<void>;
  findPasswordReset(tokenHash: string): Promise<PasswordResetRecord | null>;
  deletePasswordResetsForUser(userId: string): Promise<void>;
}

/** Normalizes emails so `A@B.com` and `a@b.com` can't become two accounts. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class InMemoryUserRepository implements UserRepository {
  private readonly usersById = new Map<string, UserRecord>();
  private readonly usersByEmail = new Map<string, UserRecord>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly resets = new Map<string, PasswordResetRecord>();

  async findByEmail(email: string): Promise<UserRecord | null> {
    return this.usersByEmail.get(normalizeEmail(email)) ?? null;
  }

  async findById(id: string): Promise<UserRecord | null> {
    return this.usersById.get(id) ?? null;
  }

  async create(user: UserRecord): Promise<void> {
    this.usersById.set(user.id, user);
    this.usersByEmail.set(normalizeEmail(user.email), user);
  }

  async updatePassword(userId: string, passwordHash: string): Promise<void> {
    const user = this.usersById.get(userId);
    if (!user) return;
    const updated: UserRecord = { ...user, passwordHash };
    this.usersById.set(userId, updated);
    this.usersByEmail.set(normalizeEmail(user.email), updated);
  }

  async createSession(session: SessionRecord): Promise<void> {
    this.sessions.set(session.token, session);
  }

  async findSession(token: string): Promise<SessionRecord | null> {
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt.getTime() < Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return session;
  }

  async deleteSession(token: string): Promise<void> {
    this.sessions.delete(token);
  }

  async findSessionsByUser(userId: string): Promise<readonly SessionRecord[]> {
    const now = Date.now();
    const live: SessionRecord[] = [];
    for (const session of this.sessions.values()) {
      if (session.userId === userId && session.expiresAt.getTime() >= now) live.push(session);
    }
    return live;
  }

  async deleteSessionsForUser(userId: string, exceptToken?: string): Promise<void> {
    for (const [token, session] of this.sessions) {
      if (session.userId === userId && token !== exceptToken) this.sessions.delete(token);
    }
  }

  async renewSession(token: string, expiresAt: Date): Promise<void> {
    const session = this.sessions.get(token);
    if (session) this.sessions.set(token, { ...session, expiresAt });
  }

  async createPasswordReset(reset: PasswordResetRecord): Promise<void> {
    this.resets.set(reset.tokenHash, reset);
  }

  async findPasswordReset(tokenHash: string): Promise<PasswordResetRecord | null> {
    const reset = this.resets.get(tokenHash);
    if (!reset) return null;
    if (reset.expiresAt.getTime() < Date.now()) {
      this.resets.delete(tokenHash);
      return null;
    }
    return reset;
  }

  async deletePasswordResetsForUser(userId: string): Promise<void> {
    for (const [hash, reset] of this.resets) {
      if (reset.userId === userId) this.resets.delete(hash);
    }
  }
}
