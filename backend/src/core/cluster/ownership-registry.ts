/**
 * Which node owns which match.
 *
 * A live match is *not* a stateless request: it holds dealt hands in memory and
 * runs an AI turn loop on a timer. Two nodes driving the same match would deal
 * two different next hands. So exactly one node owns a match at a time, and
 * every command for that match is routed to it (see `match-gateway.ts`).
 *
 * Ownership is a **lease**, not a permanent record: a key with a TTL that the
 * owning node renews on a timer. If a node dies, its leases simply expire and
 * another node can take over — no tombstones to clean up, no risk of a match
 * being unreachable forever because the node that held it is gone.
 *
 * Every write is a compare-and-set on the node ID, so a node whose renewal was
 * late (and whose lease therefore expired and was taken by someone else) can
 * never stomp the new owner.
 */

import type { RedisBundle } from '../redis/redis-client.js';

export interface OwnershipRegistry {
  /** Takes the lease if it is free. Returns the current owner either way. */
  claim(matchId: string, nodeId: string, ttlMs: number): Promise<string>;
  owner(matchId: string): Promise<string | null>;
  /** Extends our lease. False means we lost it — the caller must stop acting as owner. */
  renew(matchId: string, nodeId: string, ttlMs: number): Promise<boolean>;
  /** Drops the lease, but only if we still hold it. */
  release(matchId: string, nodeId: string): Promise<void>;
}

// ---- In-process ------------------------------------------------------------

/**
 * Single-node registry. Also used in tests: two `MatchGateway`s sharing one
 * `LocalOwnershipRegistry` behave like two nodes sharing one Redis.
 */
export class LocalOwnershipRegistry implements OwnershipRegistry {
  private readonly leases = new Map<string, { nodeId: string; expiresAt: number }>();

  private live(matchId: string): { nodeId: string; expiresAt: number } | null {
    const lease = this.leases.get(matchId);
    if (!lease) return null;
    if (lease.expiresAt <= Date.now()) {
      this.leases.delete(matchId);
      return null;
    }
    return lease;
  }

  async claim(matchId: string, nodeId: string, ttlMs: number): Promise<string> {
    const existing = this.live(matchId);
    if (existing) return existing.nodeId;
    this.leases.set(matchId, { nodeId, expiresAt: Date.now() + ttlMs });
    return nodeId;
  }

  async owner(matchId: string): Promise<string | null> {
    return this.live(matchId)?.nodeId ?? null;
  }

  async renew(matchId: string, nodeId: string, ttlMs: number): Promise<boolean> {
    const existing = this.live(matchId);
    if (existing?.nodeId !== nodeId) return false;
    existing.expiresAt = Date.now() + ttlMs;
    return true;
  }

  async release(matchId: string, nodeId: string): Promise<void> {
    if (this.live(matchId)?.nodeId === nodeId) this.leases.delete(matchId);
  }
}

// ---- Redis -----------------------------------------------------------------

/**
 * `SET key node NX PX ttl` then `GET` in one round trip: if we won, the reply
 * is our own node ID; if we lost, it is the incumbent's — which is exactly what
 * the caller needs to know where to route.
 */
const CLAIM_LUA = `
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then
  return ARGV[1]
end
return redis.call('GET', KEYS[1])
`;

/** Renew only while we are still the recorded owner. */
const RENEW_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

/** The canonical safe-unlock: never delete a lease someone else now holds. */
const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export class RedisOwnershipRegistry implements OwnershipRegistry {
  private readonly prefix: string;

  constructor(private readonly redis: RedisBundle) {
    this.prefix = `${redis.keyPrefix}:owner:`;
    // Registering the scripts as commands lets ioredis use EVALSHA and fall
    // back to EVAL automatically after a Redis restart flushes the script cache.
    this.redis.commands.defineCommand('hcgClaimLease', { numberOfKeys: 1, lua: CLAIM_LUA });
    this.redis.commands.defineCommand('hcgRenewLease', { numberOfKeys: 1, lua: RENEW_LUA });
    this.redis.commands.defineCommand('hcgReleaseLease', { numberOfKeys: 1, lua: RELEASE_LUA });
  }

  private key(matchId: string): string {
    return this.prefix + matchId;
  }

  async claim(matchId: string, nodeId: string, ttlMs: number): Promise<string> {
    const scripted = this.redis.commands as unknown as {
      hcgClaimLease(key: string, nodeId: string, ttlMs: string): Promise<string | null>;
    };
    // A null here means the key vanished between SET and GET (TTL raced us).
    // Treating that as "we own it" is safe: nobody else holds a lease either.
    return (await scripted.hcgClaimLease(this.key(matchId), nodeId, String(ttlMs))) ?? nodeId;
  }

  async owner(matchId: string): Promise<string | null> {
    return this.redis.commands.get(this.key(matchId));
  }

  async renew(matchId: string, nodeId: string, ttlMs: number): Promise<boolean> {
    const scripted = this.redis.commands as unknown as {
      hcgRenewLease(key: string, nodeId: string, ttlMs: string): Promise<number>;
    };
    return (await scripted.hcgRenewLease(this.key(matchId), nodeId, String(ttlMs))) === 1;
  }

  async release(matchId: string, nodeId: string): Promise<void> {
    const scripted = this.redis.commands as unknown as {
      hcgReleaseLease(key: string, nodeId: string): Promise<number>;
    };
    await scripted.hcgReleaseLease(this.key(matchId), nodeId);
  }
}
