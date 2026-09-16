/**
 * How many live sockets an account holds, counted across every node.
 *
 * `WsServer` already caps connections per user, but it counts its own `Map` —
 * which is the whole cluster only while there is one node. Run four and the
 * cap silently becomes four times what it says, so the reconnect loop it was
 * written to contain gets four times the file descriptors.
 *
 * The hard part is not counting, it is **counting things that may already be
 * gone**. A node that is SIGKILLed never removes its entries, and a permanent
 * `+1` per crash would eventually lock a user out of their own account. So an
 * entry is not a flag but a *lease with an expiry*: every connection is
 * re-registered on the same heartbeat sweep that pings the socket, and anything
 * whose lease has run out is pruned at read time. A crashed node's entries age
 * out on their own within one TTL, with no cleanup job and no tombstones.
 *
 * As everywhere else in `core/cluster`, there are two implementations behind
 * one interface: the local one is exact for a single process, the Redis one is
 * exact for any number of them.
 */

import type { RedisBundle } from '../redis/redis-client.js';

export interface ConnectionRegistry {
  /**
   * Records a connection (or refreshes one already recorded) and returns how
   * many that account now holds cluster-wide, this one included.
   */
  register(userId: string, connectionId: string, ttlMs: number): Promise<number>;
  /** Drops a connection immediately, rather than waiting out its lease. */
  release(userId: string, connectionId: string): Promise<void>;
  /** Current count, expired entries excluded. */
  count(userId: string): Promise<number>;
}

// ---- In-process ------------------------------------------------------------

export class LocalConnectionRegistry implements ConnectionRegistry {
  /** userId -> connectionId -> lease expiry (unix ms). */
  private readonly byUser = new Map<string, Map<string, number>>();

  async register(userId: string, connectionId: string, ttlMs: number): Promise<number> {
    let conns = this.byUser.get(userId);
    if (!conns) {
      conns = new Map();
      this.byUser.set(userId, conns);
    }
    conns.set(connectionId, Date.now() + ttlMs);
    return this.prune(userId, conns);
  }

  async release(userId: string, connectionId: string): Promise<void> {
    const conns = this.byUser.get(userId);
    if (!conns) return;
    conns.delete(connectionId);
    if (conns.size === 0) this.byUser.delete(userId);
  }

  async count(userId: string): Promise<number> {
    const conns = this.byUser.get(userId);
    if (!conns) return 0;
    return this.prune(userId, conns);
  }

  private prune(userId: string, conns: Map<string, number>): number {
    const now = Date.now();
    for (const [id, expiresAt] of conns) {
      if (expiresAt <= now) conns.delete(id);
    }
    if (conns.size === 0) this.byUser.delete(userId);
    return conns.size;
  }
}

// ---- Redis -----------------------------------------------------------------

/**
 * One sorted set per user: member = connection id, score = lease expiry.
 *
 * Pruning, adding, and counting have to be one atomic step. Split across three
 * round trips, two nodes registering at the same moment can both read a count
 * taken before the other's insert, and both conclude the user is under the cap.
 */
const REGISTER_LUA = `
local key = KEYS[1]
local id  = ARGV[1]
local now = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])

redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
redis.call('ZADD', key, now + ttl, id)
-- Outlive the longest lease it can hold, so the key disappears once the last
-- connection stops renewing rather than lingering as an empty set forever.
redis.call('PEXPIRE', key, ttl + 5000)
return redis.call('ZCARD', key)
`;

/** Prune-then-count, for the same atomicity reason. */
const COUNT_LUA = `
local key = KEYS[1]
redis.call('ZREMRANGEBYSCORE', key, '-inf', tonumber(ARGV[1]))
return redis.call('ZCARD', key)
`;

export class RedisConnectionRegistry implements ConnectionRegistry {
  private readonly prefix: string;
  private readonly fallback = new LocalConnectionRegistry();

  constructor(private readonly redis: RedisBundle) {
    this.prefix = `${redis.keyPrefix}:conns:`;
    this.redis.commands.defineCommand('hcgRegisterConn', { numberOfKeys: 1, lua: REGISTER_LUA });
    this.redis.commands.defineCommand('hcgCountConns', { numberOfKeys: 1, lua: COUNT_LUA });
  }

  private key(userId: string): string {
    return this.prefix + userId;
  }

  async register(userId: string, connectionId: string, ttlMs: number): Promise<number> {
    const scripted = this.redis.commands as unknown as {
      hcgRegisterConn(key: string, id: string, now: string, ttl: string): Promise<number>;
    };
    try {
      return await scripted.hcgRegisterConn(this.key(userId), connectionId, String(Date.now()), String(ttlMs));
    } catch {
      // Degrade to this node's own count. Weaker than a cluster-wide cap, but
      // refusing every connection because Redis blinked would be far worse:
      // the cap exists to contain a reconnect loop, not to gate normal play.
      return this.fallback.register(userId, connectionId, ttlMs);
    }
  }

  async release(userId: string, connectionId: string): Promise<void> {
    await this.fallback.release(userId, connectionId);
    try {
      await this.redis.commands.zrem(this.key(userId), connectionId);
    } catch {
      /* the lease expires on its own within one TTL */
    }
  }

  async count(userId: string): Promise<number> {
    const scripted = this.redis.commands as unknown as {
      hcgCountConns(key: string, now: string): Promise<number>;
    };
    try {
      return await scripted.hcgCountConns(this.key(userId), String(Date.now()));
    } catch {
      return this.fallback.count(userId);
    }
  }
}
