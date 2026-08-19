/**
 * User + session storage. Interface-first so the server can boot on
 * `InMemoryUserRepository` when Mongo is unreachable (as it currently is —
 * see the Atlas IP allowlist issue), with the Mongo implementation dropping
 * in unchanged once the DB connects.
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

export interface UserRepository {
  findByEmail(email: string): Promise<UserRecord | null>;
  findById(id: string): Promise<UserRecord | null>;
  create(user: UserRecord): Promise<void>;

  createSession(session: SessionRecord): Promise<void>;
  findSession(token: string): Promise<SessionRecord | null>;
  deleteSession(token: string): Promise<void>;
}

/** Normalizes emails so `A@B.com` and `a@b.com` can't become two accounts. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class InMemoryUserRepository implements UserRepository {
  private readonly usersById = new Map<string, UserRecord>();
  private readonly usersByEmail = new Map<string, UserRecord>();
  private readonly sessions = new Map<string, SessionRecord>();

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
}
