/**
 * Mongo-backed users + sessions. Unique index on the normalized email makes
 * duplicate registration a database-level guarantee rather than relying on a
 * check-then-insert race in application code.
 */

import type { Collection, Db } from 'mongodb';
import { normalizeEmail, type SessionRecord, type UserRepository, type UserRecord } from './user-repository.js';

interface UserDocument {
  readonly _id: string;
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly createdAt: Date;
}

interface SessionDocument {
  readonly _id: string; // token
  readonly userId: string;
  readonly expiresAt: Date;
}

export class MongoUserRepository implements UserRepository {
  private constructor(
    private readonly users: Collection<UserDocument>,
    private readonly sessions: Collection<SessionDocument>,
  ) {}

  static async create(db: Db): Promise<MongoUserRepository> {
    // Namespaced collection names. The target database may already contain
    // `users`/`sessions` from an unrelated (Mongoose-based) app with an
    // incompatible schema that permits duplicate emails — writing into those
    // would both corrupt their data and break our unique-email guarantee.
    const users = db.collection<UserDocument>('hcg_users');
    const sessions = db.collection<SessionDocument>('hcg_sessions');
    await users.createIndex({ email: 1 }, { unique: true });
    // TTL index: Mongo evicts expired sessions on its own, no cleanup job needed.
    await sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    return new MongoUserRepository(users, sessions);
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const doc = await this.users.findOne({ email: normalizeEmail(email) });
    return doc ? toUserRecord(doc) : null;
  }

  async findById(id: string): Promise<UserRecord | null> {
    const doc = await this.users.findOne({ _id: id });
    return doc ? toUserRecord(doc) : null;
  }

  async create(user: UserRecord): Promise<void> {
    await this.users.insertOne({
      _id: user.id,
      email: normalizeEmail(user.email),
      displayName: user.displayName,
      passwordHash: user.passwordHash,
      createdAt: user.createdAt,
    });
  }

  async createSession(session: SessionRecord): Promise<void> {
    await this.sessions.insertOne({
      _id: session.token,
      userId: session.userId,
      expiresAt: session.expiresAt,
    });
  }

  async findSession(token: string): Promise<SessionRecord | null> {
    const doc = await this.sessions.findOne({ _id: token });
    if (!doc) return null;
    // Don't trust the TTL reaper for correctness — it runs on a ~60s cycle.
    if (doc.expiresAt.getTime() < Date.now()) return null;
    return { token: doc._id, userId: doc.userId, expiresAt: doc.expiresAt };
  }

  async deleteSession(token: string): Promise<void> {
    await this.sessions.deleteOne({ _id: token });
  }
}

function toUserRecord(doc: UserDocument): UserRecord {
  return {
    id: doc._id,
    email: doc.email,
    displayName: doc.displayName,
    passwordHash: doc.passwordHash,
    createdAt: doc.createdAt,
  };
}
