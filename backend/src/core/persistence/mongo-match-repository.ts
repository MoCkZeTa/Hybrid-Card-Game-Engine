/**
 * Real `MatchRepository` backed by MongoDB Atlas. One document per match,
 * upserted in place — we don't need per-move history documents for v1, just
 * "the latest durable state", which is all a resume needs.
 */

import { MongoClient, type Collection, type Db } from 'mongodb';
import type { GameState } from '@hcg/shared';
import type { MatchRepository, PersistedMatch } from './match-repository.js';

interface MatchDocument {
  readonly _id: string; // matchId
  readonly gameId: string;
  readonly sequence: number;
  readonly state: GameState;
  readonly updatedAt: Date;
}

export class MongoMatchRepository implements MatchRepository {
  private constructor(private readonly collection: Collection<MatchDocument>) {}

  static async connect(uri: string, dbName?: string): Promise<MongoMatchRepository> {
    const client = new MongoClient(uri);
    await client.connect();
    return MongoMatchRepository.fromDb(dbName ? client.db(dbName) : client.db());
  }

  /** Builds on an already-connected `Db` so the server can share one MongoClient across repositories. */
  static async fromDb(db: Db): Promise<MongoMatchRepository> {
    // Namespaced to stay clear of any pre-existing collections in the target
    // database — see the note in MongoUserRepository.create.
    const collection = db.collection<MatchDocument>('hcg_matches');
    await collection.createIndex({ updatedAt: 1 });
    return new MongoMatchRepository(collection);
  }

  async save(matchId: string, gameId: string, sequence: number, state: GameState): Promise<void> {
    // Single atomic upsert via an aggregation-pipeline update: only overwrite
    // sequence/state/gameId if this write is newer than (or the document
    // doesn't exist yet vs.) what's already stored. Writes are fired off the
    // critical path and are not guaranteed to arrive in order, so a slow
    // stale write must never clobber a newer one that landed first.
    await this.collection.updateOne(
      { _id: matchId },
      [
        {
          $set: {
            updatedAt: new Date(),
            gameId: { $cond: [{ $gt: [sequence, { $ifNull: ['$sequence', -1] }] }, gameId, '$gameId'] },
            sequence: { $cond: [{ $gt: [sequence, { $ifNull: ['$sequence', -1] }] }, sequence, '$sequence'] },
            state: { $cond: [{ $gt: [sequence, { $ifNull: ['$sequence', -1] }] }, state, '$state'] },
          },
        },
      ],
      { upsert: true },
    );
  }

  async load(matchId: string): Promise<PersistedMatch | null> {
    const doc = await this.collection.findOne({ _id: matchId });
    if (!doc) return null;
    return { matchId: doc._id, gameId: doc.gameId, sequence: doc.sequence, state: doc.state, updatedAt: doc.updatedAt };
  }

  async delete(matchId: string): Promise<void> {
    await this.collection.deleteOne({ _id: matchId });
  }
}
