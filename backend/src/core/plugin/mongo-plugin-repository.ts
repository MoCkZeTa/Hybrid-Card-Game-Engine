/**
 * Real `PluginRepository` backed by MongoDB Atlas. One document per plugin.
 *
 * `_id` is a genuine `ObjectId` that Mongo mints on insert rather than a
 * caller-supplied string — the plugin's id *is* its document id, which is what
 * "assigned by the store" means here. The hex form of that ObjectId is the
 * `gameId` every other layer sees.
 */

import { MongoClient, ObjectId, type Collection, type Db, type Filter } from 'mongodb';
import type { RulesDsl } from '@hcg/shared';
import type { PluginContent, PluginRepository, StoredPlugin } from './plugin-repository.js';

interface PluginDocument {
  /**
   * An `ObjectId` for anything this code inserted. Documents imported before
   * ids were store-assigned carry a caller-supplied **string** instead — the
   * old `rules.json` gameId, e.g. `"mendicot"`. Those are still live plugins
   * that someone owns, so both shapes have to be readable.
   */
  readonly _id: ObjectId | string;
  readonly rules: RulesDsl;
  readonly strategy: string;
  readonly ownerUserId: string;
  readonly updatedAt: Date;
}

export class MongoPluginRepository implements PluginRepository {
  private constructor(private readonly collection: Collection<PluginDocument>) {}

  static async connect(uri: string, dbName?: string): Promise<MongoPluginRepository> {
    const client = new MongoClient(uri);
    await client.connect();
    return MongoPluginRepository.fromDb(dbName ? client.db(dbName) : client.db());
  }

  /** Builds on an already-connected `Db` so the server can share one MongoClient across repositories. */
  static async fromDb(db: Db): Promise<MongoPluginRepository> {
    const collection = db.collection<PluginDocument>('hcg_plugins');
    await collection.createIndex({ ownerUserId: 1 });
    return new MongoPluginRepository(collection);
  }

  async create(plugin: PluginContent): Promise<StoredPlugin> {
    // No _id supplied: the driver/server generates it, and `insertedId` is the
    // authoritative id from that point on.
    const result = await this.collection.insertOne({
      rules: plugin.rules,
      strategy: plugin.strategy,
      ownerUserId: plugin.ownerUserId,
      updatedAt: plugin.updatedAt,
    } as PluginDocument);
    return { ...plugin, gameId: idToString(result.insertedId) };
  }

  async update(gameId: string, plugin: PluginContent): Promise<void> {
    await this.collection.updateOne(
      idFilter(gameId),
      {
        $set: {
          rules: plugin.rules,
          strategy: plugin.strategy,
          ownerUserId: plugin.ownerUserId,
          updatedAt: plugin.updatedAt,
        },
      },
    );
  }

  async findById(gameId: string): Promise<StoredPlugin | null> {
    const doc = await this.collection.findOne(idFilter(gameId));
    return doc ? toStored(doc) : null;
  }

  async findByOwner(ownerUserId: string): Promise<StoredPlugin[]> {
    const docs = await this.collection.find({ ownerUserId }).toArray();
    return docs.map(toStored);
  }

  async delete(gameId: string): Promise<void> {
    await this.collection.deleteOne(idFilter(gameId));
  }
}

/**
 * Matches a plugin by id in either shape the collection holds — a store-minted
 * `ObjectId` or a legacy string `_id` (see `PluginDocument`). Matching on both
 * at once matters: an id like `"mendicot"` is not a valid `ObjectId`, so the
 * previous ObjectId-only lookup silently resolved to "no such plugin" and made
 * those plugins impossible to open, edit or delete.
 *
 * Ids arrive here straight from a URL path segment and the `ObjectId`
 * constructor *throws* on a malformed one, so it is only ever built behind
 * `isValid`. A built-in's folder-name id (`callbreak`) simply matches nothing,
 * which is the intended "no such document".
 */
function idFilter(gameId: string): Filter<PluginDocument> {
  const candidates: (ObjectId | string)[] = [gameId];
  if (ObjectId.isValid(gameId)) candidates.push(new ObjectId(gameId));
  return { _id: { $in: candidates } } as Filter<PluginDocument>;
}

/** Renders either `_id` shape as the string gameId every other layer speaks. */
function idToString(id: ObjectId | string): string {
  return id instanceof ObjectId ? id.toHexString() : String(id);
}

function toStored(doc: PluginDocument): StoredPlugin {
  return {
    gameId: idToString(doc._id),
    rules: doc.rules,
    strategy: doc.strategy,
    ownerUserId: doc.ownerUserId,
    updatedAt: doc.updatedAt,
  };
}
