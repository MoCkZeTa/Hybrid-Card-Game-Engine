/**
 * Real `DesignSessionRepository` backed by MongoDB Atlas. One document per
 * design session, mirroring `MongoPluginRepository`: `_id` is an `ObjectId`
 * the server mints on insert, and its hex form is the `sessionId` every other
 * layer speaks.
 */

import { MongoClient, ObjectId, type Collection, type Db, type Filter } from 'mongodb';
import type { DesignRevision } from '@hcg/shared';
import type {
  DesignSession,
  DesignSessionContent,
  DesignSessionRepository,
} from './design-session-repository.js';

interface DesignSessionDocument {
  readonly _id: ObjectId;
  readonly ownerUserId: string;
  readonly title: string;
  readonly revisions: readonly DesignRevision[];
  readonly publishedGameId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class MongoDesignSessionRepository implements DesignSessionRepository {
  private constructor(private readonly collection: Collection<DesignSessionDocument>) {}

  static async connect(uri: string, dbName?: string): Promise<MongoDesignSessionRepository> {
    const client = new MongoClient(uri);
    await client.connect();
    return MongoDesignSessionRepository.fromDb(dbName ? client.db(dbName) : client.db());
  }

  /** Builds on an already-connected `Db` so the server shares one MongoClient across repositories. */
  static async fromDb(db: Db): Promise<MongoDesignSessionRepository> {
    const collection = db.collection<DesignSessionDocument>('hcg_design_sessions');
    // The only two queries this repository makes are "this user's sessions,
    // newest first" and "count this user's sessions" — one compound index
    // serves both.
    await collection.createIndex({ ownerUserId: 1, updatedAt: -1 });
    return new MongoDesignSessionRepository(collection);
  }

  async create(session: DesignSessionContent): Promise<DesignSession> {
    const result = await this.collection.insertOne({
      ownerUserId: session.ownerUserId,
      title: session.title,
      revisions: session.revisions,
      publishedGameId: session.publishedGameId,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    } as DesignSessionDocument);
    return { ...session, sessionId: result.insertedId.toHexString() };
  }

  async update(sessionId: string, session: DesignSessionContent): Promise<void> {
    const filter = idFilter(sessionId);
    if (!filter) return;
    await this.collection.updateOne(filter, {
      $set: {
        title: session.title,
        revisions: session.revisions,
        publishedGameId: session.publishedGameId,
        updatedAt: session.updatedAt,
      },
    });
  }

  async findById(sessionId: string): Promise<DesignSession | null> {
    const filter = idFilter(sessionId);
    if (!filter) return null;
    const doc = await this.collection.findOne(filter);
    return doc ? toSession(doc) : null;
  }

  async findByOwner(ownerUserId: string): Promise<DesignSession[]> {
    const docs = await this.collection.find({ ownerUserId }).sort({ updatedAt: -1 }).toArray();
    return docs.map(toSession);
  }

  async countByOwner(ownerUserId: string): Promise<number> {
    return this.collection.countDocuments({ ownerUserId });
  }

  async delete(sessionId: string): Promise<void> {
    const filter = idFilter(sessionId);
    if (!filter) return;
    await this.collection.deleteOne(filter);
  }
}

/**
 * Ids arrive here straight from a URL path segment and `ObjectId`'s constructor
 * *throws* on a malformed one, so it is only ever built behind `isValid`. A
 * garbage id resolves to null — "no such session" — rather than a 500.
 *
 * Unlike `MongoPluginRepository` there is no legacy string-`_id` shape to
 * accommodate: this collection has only ever held server-minted ObjectIds.
 */
function idFilter(sessionId: string): Filter<DesignSessionDocument> | null {
  if (!ObjectId.isValid(sessionId)) return null;
  return { _id: new ObjectId(sessionId) } as Filter<DesignSessionDocument>;
}

function toSession(doc: DesignSessionDocument): DesignSession {
  return {
    sessionId: doc._id.toHexString(),
    ownerUserId: doc.ownerUserId,
    title: doc.title,
    revisions: doc.revisions ?? [],
    publishedGameId: doc.publishedGameId ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}
