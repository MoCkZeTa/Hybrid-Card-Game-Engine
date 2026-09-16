/**
 * Mongo-backed users, sessions, and password resets. Unique index on the
 * normalized email makes duplicate registration a database-level guarantee
 * rather than relying on a check-then-insert race in application code.
 */

import type { Collection, Db } from 'mongodb';
import {
  normalizeEmail,
  type PasswordResetRecord,
  type SessionRecord,
  type UserRepository,
  type UserRecord,
} from './user-repository.js';

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

interface PasswordResetDocument {
  readonly _id: string; // SHA-256 of the emailed token, never the token itself
  readonly userId: string;
  readonly expiresAt: Date;
}

export class MongoUserRepository implements UserRepository {
  private constructor(
    private readonly users: Collection<UserDocument>,
    private readonly sessions: Collection<SessionDocument>,
    private readonly resets: Collection<PasswordResetDocument>,
  ) {}

  static async create(db: Db): Promise<MongoUserRepository> {
    // Namespaced collection names. The target database may already contain
    // `users`/`sessions` from an unrelated (Mongoose-based) app with an
    // incompatible schema that permits duplicate emails — writing into those
    // would both corrupt their data and break our unique-email guarantee.
    const users = db.collection<UserDocument>('hcg_users');
    const sessions = db.collection<SessionDocument>('hcg_sessions');
    const resets = db.collection<PasswordResetDocument>('hcg_password_resets');
    await users.createIndex({ email: 1 }, { unique: true });
    // TTL indexes: Mongo evicts expired rows on its own, no cleanup job needed.
    await sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await resets.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    // Bulk revoke and "list my sessions" both scan by user; without this they
    // are a collection scan on the hottest collection in the system.
    await sessions.createIndex({ userId: 1 });
    await resets.createIndex({ userId: 1 });
    return new MongoUserRepository(users, sessions, resets);
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

  async updatePassword(userId: string, passwordHash: string): Promise<void> {
    await this.users.updateOne({ _id: userId }, { $set: { passwordHash } });
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

  async findSessionsByUser(userId: string): Promise<readonly SessionRecord[]> {
    const docs = await this.sessions.find({ userId, expiresAt: { $gte: new Date() } }).toArray();
    return docs.map((doc) => ({ token: doc._id, userId: doc.userId, expiresAt: doc.expiresAt }));
  }

  async deleteSessionsForUser(userId: string, exceptToken?: string): Promise<void> {
    await this.sessions.deleteMany(
      exceptToken ? { userId, _id: { $ne: exceptToken } } : { userId },
    );
  }

  async renewSession(token: string, expiresAt: Date): Promise<void> {
    await this.sessions.updateOne({ _id: token }, { $set: { expiresAt } });
  }

  async createPasswordReset(reset: PasswordResetRecord): Promise<void> {
    await this.resets.insertOne({
      _id: reset.tokenHash,
      userId: reset.userId,
      expiresAt: reset.expiresAt,
    });
  }

  async findPasswordReset(tokenHash: string): Promise<PasswordResetRecord | null> {
    const doc = await this.resets.findOne({ _id: tokenHash });
    if (!doc) return null;
    if (doc.expiresAt.getTime() < Date.now()) return null;
    return { tokenHash: doc._id, userId: doc.userId, expiresAt: doc.expiresAt };
  }

  async deletePasswordResetsForUser(userId: string): Promise<void> {
    await this.resets.deleteMany({ userId });
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
