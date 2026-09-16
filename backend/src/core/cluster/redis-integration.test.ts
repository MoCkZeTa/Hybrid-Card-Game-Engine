/**
 * The suite that runs against a **real Redis server**.
 *
 * Everything else in `core/cluster` is tested through in-memory siblings and a
 * shared in-process backplane. That proves the *routing* logic, which is the
 * part most likely to be wrong — but it cannot execute a single line of Lua and
 * never opens a socket, so the Lua scripts and the `ioredis` wiring underneath
 * were the one genuinely unexercised path in the project.
 *
 * These tests close that gap. They are skipped unless `REDIS_TEST_URL` is set,
 * so the default `npm run test` stays offline and instant; set it and the same
 * assertions run against the real thing.
 *
 *     REDIS_TEST_URL=redis://localhost:6379 npx vitest run redis-integration
 *
 * **Exactly two connection bundles are opened for the whole suite**, standing in
 * for two backend nodes. That is not tidiness — a managed Redis free tier caps
 * concurrent connections (Redis Cloud allows 30) and every bundle opens three
 * sockets, so a bundle per test exhausts the allowance partway through and the
 * rest of the run fails with a misleading "Connection is closed".
 *
 * Every key is written under a prefix unique to the run, and the prefix is
 * deleted afterwards, so a shared or managed database is safe to point at —
 * though a throwaway one is still the better idea.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import type { BotLevel, MaskedGameState } from '@hcg/shared';
import { createRedisBundle, type RedisBundle } from '../redis/redis-client.js';
import { RedisOwnershipRegistry } from './ownership-registry.js';
import { RedisEventBus, RequestTimeoutError } from './event-bus.js';
import { RedisConnectionRegistry } from './connection-registry.js';
import { RedisRateLimiter } from '../ratelimit/rate-limiter.js';
import { RedisSessionCache } from '../auth/session-cache.js';
import { PluginManager } from '../plugin/plugin-manager.js';
import { InMemoryPluginRepository } from '../plugin/plugin-repository.js';
import { InMemoryMatchRepository } from '../persistence/match-repository.js';
import { AsyncPersistenceWriter } from '../persistence/persist-writer.js';
import { MatchManager } from '../match/match-manager.js';
import type { LLMDecisionRequest, LLMDecisionResponse, LLMProvider } from '../ai/provider.js';
import { MatchGateway, type Fanout } from './match-gateway.js';

// The repo-root .env, same file the server reads.
loadEnv({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '.env') });

const REDIS_URL = process.env.REDIS_TEST_URL?.trim();
const gamesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'games');

/** Unique per run, so two people running this against one database cannot collide. */
const KEY_PREFIX = `hcgtest-${randomUUID().slice(0, 8)}`;

/** A cloud Redis is a network hop away; assertions that take 1ms on localhost take 200. */
const NET_TIMEOUT = 30_000;

/** The two "nodes". See the connection-cap note in the file header. */
let redisA: RedisBundle;
let redisB: RedisBundle;
let busA: RedisEventBus;
let busB: RedisEventBus;

/**
 * Polls until `predicate` holds. Fixed sleeps are the usual way to wait on
 * pub/sub and the usual reason a suite is flaky: the delay that works on
 * localhost is not the delay that works against a server in another region.
 */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeAll(async () => {
  if (!REDIS_URL) return;
  const open = (): Promise<RedisBundle> =>
    createRedisBundle({ url: REDIS_URL, keyPrefix: KEY_PREFIX, commandTimeoutMs: 10_000 });
  [redisA, redisB] = await Promise.all([open(), open()]);
  busA = new RedisEventBus(redisA);
  busB = new RedisEventBus(redisB);
}, NET_TIMEOUT);

afterAll(async () => {
  if (!REDIS_URL || !redisA) return;
  try {
    // Clean up after ourselves — every key this suite writes starts with the
    // run's own prefix.
    const keys = await redisA.commands.keys(`${KEY_PREFIX}:*`);
    if (keys.length > 0) await redisA.commands.del(...keys);
  } catch {
    /* best effort — the keys all carry TTLs anyway */
  }
  await Promise.allSettled([redisA.close(), redisB.close()]);
});

describe.skipIf(!REDIS_URL)('Redis integration', () => {
  describe('connection bundle', () => {
    it('connects all three sockets and reports itself healthy', async () => {
      expect(await redisA.commands.ping()).toBe('PONG');

      const health = redisA.health();
      expect(health.healthy).toBe(true);
      expect(health.commands).toBe('ready');
      expect(health.publisher).toBe('ready');
      expect(health.subscriber).toBe('ready');
    }, NET_TIMEOUT);
  });

  // ---- Ownership leases (the CLAIM/RENEW/RELEASE Lua) -----------------------

  describe('RedisOwnershipRegistry', () => {
    it('gives the lease to exactly one node and tells the loser who won', async () => {
      const registry = new RedisOwnershipRegistry(redisA);
      const matchId = `m-${randomUUID()}`;

      expect(await registry.claim(matchId, 'node-a', 30_000)).toBe('node-a');
      // The loser gets the incumbent's id back — that is what tells the gateway
      // where to route, so it has to be the winner's name, not a boolean.
      expect(await registry.claim(matchId, 'node-b', 30_000)).toBe('node-a');
      expect(await registry.owner(matchId)).toBe('node-a');
    }, NET_TIMEOUT);

    it('renews only for the holder, so a late node cannot stomp the new owner', async () => {
      const registry = new RedisOwnershipRegistry(redisA);
      const matchId = `m-${randomUUID()}`;
      await registry.claim(matchId, 'node-a', 30_000);

      expect(await registry.renew(matchId, 'node-a', 30_000)).toBe(true);
      expect(await registry.renew(matchId, 'node-b', 30_000)).toBe(false);
      expect(await registry.owner(matchId)).toBe('node-a');
    }, NET_TIMEOUT);

    it('releases only for the holder', async () => {
      const registry = new RedisOwnershipRegistry(redisA);
      const matchId = `m-${randomUUID()}`;
      await registry.claim(matchId, 'node-a', 30_000);

      // A stale node releasing must not free someone else's lease.
      await registry.release(matchId, 'node-b');
      expect(await registry.owner(matchId)).toBe('node-a');

      await registry.release(matchId, 'node-a');
      expect(await registry.owner(matchId)).toBeNull();
    }, NET_TIMEOUT);

    it("lets a dead node's lease expire on its own", async () => {
      const registry = new RedisOwnershipRegistry(redisA);
      const matchId = `m-${randomUUID()}`;

      // A node that claims and then "crashes" — never renews, never releases.
      expect(await registry.claim(matchId, 'node-crashed', 1_000)).toBe('node-crashed');
      await waitFor(async () => (await registry.owner(matchId)) === null);

      // And the match is adoptable, which is the whole point of a lease.
      expect(await registry.claim(matchId, 'node-survivor', 30_000)).toBe('node-survivor');
    }, NET_TIMEOUT);

    it('sees a claim made by the other node', async () => {
      const [fromA, fromB] = [new RedisOwnershipRegistry(redisA), new RedisOwnershipRegistry(redisB)];
      const matchId = `m-${randomUUID()}`;

      await fromA.claim(matchId, 'node-a', 30_000);
      expect(await fromB.owner(matchId)).toBe('node-a');
      expect(await fromB.claim(matchId, 'node-b', 30_000)).toBe('node-a');
    }, NET_TIMEOUT);
  });

  // ---- Pub/sub and request/reply -------------------------------------------

  describe('RedisEventBus', () => {
    it('delivers a publish from one node to a subscriber on another', async () => {
      const channel = `fanout-${randomUUID()}`;
      const seen: unknown[] = [];

      await busB.subscribe(channel, (payload) => seen.push(payload));
      await busA.publish(channel, { hello: 'world', n: 42 });

      await waitFor(() => seen.length > 0);
      expect(seen[0]).toEqual({ hello: 'world', n: 42 });
    }, NET_TIMEOUT);

    it('carries a request to the handling node and the reply back', async () => {
      const channel = `rpc-${randomUUID()}`;

      await busB.handleRequests(channel, async (payload) => {
        const { a, b } = payload as { a: number; b: number };
        return { sum: a + b };
      });

      const reply = await busA.request<{ sum: number }>(channel, { a: 2, b: 3 }, 15_000);
      expect(reply).toEqual({ sum: 5 });
    }, NET_TIMEOUT);

    it('rebuilds a remote throw as RemoteError with the original class name', async () => {
      const channel = `rpc-err-${randomUUID()}`;

      await busB.handleRequests(channel, async () => {
        const err = new Error('seat is taken');
        err.name = 'SeatTakenError';
        throw err;
      });

      // The gateway branches on `remoteName` to rethrow the real error class,
      // so losing it would turn every remote failure into a generic one.
      await expect(busA.request(channel, {}, 15_000)).rejects.toMatchObject({
        name: 'RemoteError',
        remoteName: 'SeatTakenError',
        message: 'seat is taken',
      });
    }, NET_TIMEOUT);

    it('times out rather than hanging when nobody is listening', async () => {
      await expect(busA.request(`nobody-${randomUUID()}`, {}, 500)).rejects.toBeInstanceOf(RequestTimeoutError);
    }, NET_TIMEOUT);
  });

  // ---- Rate limiting (the token-bucket Lua) --------------------------------

  describe('RedisRateLimiter', () => {
    it('spends a shared bucket down to empty and reports when to retry', async () => {
      const limiter = new RedisRateLimiter(redisA);
      const key = `rl-${randomUUID()}`;
      const rule = { capacity: 3, refillPerSecond: 1 };

      expect((await limiter.consume(key, rule)).allowed).toBe(true);
      expect((await limiter.consume(key, rule)).allowed).toBe(true);
      expect((await limiter.consume(key, rule)).allowed).toBe(true);

      const denied = await limiter.consume(key, rule);
      expect(denied.allowed).toBe(false);
      expect(denied.retryAfterMs).toBeGreaterThan(0);
    }, NET_TIMEOUT);

    it('counts two nodes against one bucket', async () => {
      // The reason this is Lua and not three round trips: two nodes must not
      // both read a count taken before the other's write.
      const [nodeA, nodeB] = [new RedisRateLimiter(redisA), new RedisRateLimiter(redisB)];
      const key = `rl-shared-${randomUUID()}`;
      const rule = { capacity: 2, refillPerSecond: 0.1 };

      expect((await nodeA.consume(key, rule)).allowed).toBe(true);
      expect((await nodeB.consume(key, rule)).allowed).toBe(true);
      expect((await nodeA.consume(key, rule)).allowed).toBe(false);
    }, NET_TIMEOUT);

    it('refills over time', async () => {
      const limiter = new RedisRateLimiter(redisA);
      const key = `rl-refill-${randomUUID()}`;
      const rule = { capacity: 1, refillPerSecond: 20 };

      expect((await limiter.consume(key, rule)).allowed).toBe(true);
      await waitFor(async () => (await limiter.consume(key, rule)).allowed);
    }, NET_TIMEOUT);

    it('hands the full budget back on reset', async () => {
      const limiter = new RedisRateLimiter(redisA);
      const key = `rl-reset-${randomUUID()}`;
      const rule = { capacity: 2, refillPerSecond: 0.01 };

      await limiter.consume(key, rule);
      await limiter.consume(key, rule);
      expect((await limiter.consume(key, rule)).allowed).toBe(false);

      // What a successful login does, so a user who mistyped twice is not left
      // sharing a drained bucket with everyone behind the same NAT.
      await limiter.reset(key);
      expect((await limiter.consume(key, rule)).allowed).toBe(true);
    }, NET_TIMEOUT);
  });

  // ---- Session cache --------------------------------------------------------

  describe('RedisSessionCache', () => {
    it('shares a cached session between nodes and distinguishes miss from known-bad', async () => {
      const [cacheA, cacheB] = [new RedisSessionCache(redisA), new RedisSessionCache(redisB)];
      const token = `tok-${randomUUID()}`;
      const user = { id: 'u1', email: 'a@b.com', displayName: 'A' };

      // undefined = never seen, ask the database.
      expect(await cacheB.get(token)).toBeUndefined();

      await cacheA.set(token, user);
      expect(await cacheB.get(token)).toEqual(user);

      // null = cached as invalid, do not ask the database. The distinction is
      // what stops a credential-stuffing flood becoming a query flood.
      const badToken = `tok-bad-${randomUUID()}`;
      await cacheA.set(badToken, null);
      expect(await cacheB.get(badToken)).toBeNull();
    }, NET_TIMEOUT);

    it('invalidates cluster-wide, so a logout on one node lands on all of them', async () => {
      const [cacheA, cacheB] = [new RedisSessionCache(redisA), new RedisSessionCache(redisB)];
      const token = `tok-${randomUUID()}`;

      await cacheA.set(token, { id: 'u1', email: 'a@b.com', displayName: 'A' });
      expect(await cacheB.get(token)).not.toBeUndefined();

      await cacheB.invalidate(token);
      expect(await cacheA.get(token)).toBeUndefined();
    }, NET_TIMEOUT);
  });

  // ---- Cluster-wide connection counting ------------------------------------

  describe('RedisConnectionRegistry', () => {
    it("counts one account's sockets across separate nodes", async () => {
      const [nodeA, nodeB] = [new RedisConnectionRegistry(redisA), new RedisConnectionRegistry(redisB)];
      const userId = `u-${randomUUID()}`;

      expect(await nodeA.register(userId, 'conn-1', 30_000)).toBe(1);
      // Without a shared count this would also be 1, and a per-user cap of 8
      // would really be 8 per node.
      expect(await nodeB.register(userId, 'conn-2', 30_000)).toBe(2);
      expect(await nodeA.count(userId)).toBe(2);
    }, NET_TIMEOUT);

    it('is idempotent for the same connection id', async () => {
      const registry = new RedisConnectionRegistry(redisA);
      const userId = `u-${randomUUID()}`;

      expect(await registry.register(userId, 'conn-1', 30_000)).toBe(1);
      // Re-registering is the heartbeat renewing its lease, not a new socket.
      expect(await registry.register(userId, 'conn-1', 30_000)).toBe(1);
    }, NET_TIMEOUT);

    it("forgets a crashed node's connections once their leases lapse", async () => {
      const registry = new RedisConnectionRegistry(redisA);
      const userId = `u-${randomUUID()}`;

      await registry.register(userId, 'conn-live', 30_000);
      // A node that registered and then died: no release, no renewal.
      await registry.register(userId, 'conn-crashed', 1_000);
      expect(await registry.count(userId)).toBe(2);

      // Without expiry-based pruning this stays 2 forever and eventually locks
      // the user out of their own account.
      await waitFor(async () => (await registry.count(userId)) === 1);
    }, NET_TIMEOUT);

    it('releases immediately on a clean disconnect', async () => {
      const registry = new RedisConnectionRegistry(redisA);
      const userId = `u-${randomUUID()}`;

      await registry.register(userId, 'conn-1', 30_000);
      await registry.release(userId, 'conn-1');
      expect(await registry.count(userId)).toBe(0);
    }, NET_TIMEOUT);
  });

  // ---- The whole cluster, end to end ---------------------------------------

  describe('two MatchGateways over real Redis', () => {
    it('routes a move made on one node into the match owned by the other, and fans the result back', async () => {
      const plugins = await PluginManager.loadAll(gamesRoot, new InMemoryPluginRepository());
      const repository = new InMemoryMatchRepository();

      const provider: LLMProvider = {
        name: 'always-first',
        decide: (req: LLMDecisionRequest): Promise<LLMDecisionResponse> =>
          Promise.resolve({ moveId: req.legalMoveIds[0]!, reasoning: 'integration stub' }),
      };
      const tiers = Object.fromEntries(
        (['easy', 'medium', 'hard', 'extreme'] as const).map((level) => [
          level,
          { provider, llmTimeoutMs: 1000, memoryFraction: 1 },
        ]),
      ) as Record<BotLevel, { provider: LLMProvider; llmTimeoutMs: number; memoryFraction: number }>;

      function buildNode(nodeId: string, redis: RedisBundle, bus: RedisEventBus) {
        const manager = new MatchManager({
          plugins,
          botTiers: tiers,
          defaultBotLevel: 'easy',
          persistence: new AsyncPersistenceWriter(repository),
          aiMoveMinDelayMs: 0,
          roundIntermissionMs: 0,
        });
        // Each node rides its own bundle. Two buses sharing one subscriber
        // connection would each see the other's messages, which is precisely
        // what a two-node test has to keep apart.
        const gateway = new MatchGateway({
          manager,
          bus,
          registry: new RedisOwnershipRegistry(redis),
          repository,
          nodeId,
          leaseTtlMs: 60_000,
        });
        return { gateway, manager };
      }

      const owner = buildNode('node-a', redisA, busA);
      const other = buildNode('node-b', redisB, busB);
      await Promise.all([owner.gateway.start(), other.gateway.start()]);

      try {
        const HOST = 'user-host';
        const matchId = await owner.gateway.createRoom('callbreak', HOST);
        // Joining through the node that does *not* own the room: this request
        // crosses Redis in both directions.
        await other.gateway.join({ matchId, seat: 0, userId: HOST, displayName: 'Host', token: 'c-host' });

        const states: MaskedGameState[] = [];
        await other.gateway.watch(matchId, (f: Fanout) => {
          if (f.kind === 'STATE') states.push(f.bySeat[0]!);
        });

        await owner.gateway.startMatch(matchId, HOST, [
          { seat: 0, userId: HOST, token: 'c-host', nodeId: other.gateway.nodeId },
        ]);

        // Presence crossed the bus, so the AI stopped on the human's seat
        // instead of playing it.
        await waitFor(async () => (await other.gateway.getMaskedState(matchId, 0)).turnSeat === 0);

        const current = await other.gateway.getMaskedState(matchId, 0);
        expect(current.legalMoves.length).toBeGreaterThan(0);

        const before = states.length;
        await other.gateway.submitMove(matchId, 0, current.legalMoves[0]!.id, HOST);

        // The move was applied on the owner and the new state came back over
        // pub/sub — the full round trip a clustered deploy depends on.
        await waitFor(() => states.length > before);
      } finally {
        await Promise.allSettled([owner.gateway.close(), other.gateway.close()]);
      }
    }, 60_000);
  });
});
