/**
 * Redis connection management.
 *
 * Redis is **optional**. With no `REDIS_URL` the server runs exactly as it did
 * before — single process, everything in memory — because every Redis-backed
 * component in `core/` ships with an in-memory sibling behind the same
 * interface. Set `REDIS_URL` and the same code fans out across as many backend
 * instances as you care to run.
 *
 * Three separate connections are created on purpose. A Redis connection in
 * subscriber mode may only issue (un)subscribe commands, so pub/sub cannot
 * share the socket that serves `GET`/`SET`/Lua. The split is:
 *
 *   - `commands`   — normal request/response traffic (leases, rate limits, cache)
 *   - `publisher`  — outgoing PUBLISH only
 *   - `subscriber` — locked into subscriber mode
 *
 * Failure policy is "degrade, don't die": a Redis outage must never take the
 * game down, so reconnection is automatic and unbounded, commands queue while
 * the socket is down, and callers get a rejected promise (which every call
 * site treats as "fall back to local behaviour") rather than an exception that
 * escapes into the turn loop.
 */

// Named import rather than the default: under NodeNext ESM, the default export
// of a CommonJS package resolves to its whole namespace, which cannot be used
// as a type. `Redis` is both the class and its type.
import { Redis, type RedisOptions } from 'ioredis';

export interface RedisBundle {
  readonly commands: Redis;
  readonly publisher: Redis;
  readonly subscriber: Redis;
  /** Key prefix applied by every component, so one Redis can host several environments. */
  readonly keyPrefix: string;
  /**
   * Live connection state, for the readiness probe.
   *
   * Reporting "Redis: yes" because the *boot* succeeded is a lie with a long
   * tail: if Redis dies at 3am, a probe built on that answer keeps returning
   * 200 and the load balancer keeps sending traffic to a node that can no
   * longer see the rest of the cluster. This reads ioredis's current status
   * instead, which is a property, not a round trip — cheap enough to call on
   * every probe.
   */
  health(): RedisHealth;
  close(): Promise<void>;
}

export interface RedisHealth {
  /** True only when every connection is usable. Pub/sub matters as much as commands. */
  readonly healthy: boolean;
  readonly commands: string;
  readonly publisher: string;
  readonly subscriber: string;
}

export interface RedisConfig {
  readonly url: string;
  readonly keyPrefix?: string;
  /** Cap on how long a single command may sit queued before rejecting. */
  readonly commandTimeoutMs?: number;
}

/**
 * Reconnect delay: fast at first (a rolling Redis restart is usually back in a
 * second or two), then backing off to 5s so a genuinely dead server does not
 * get hammered. Deliberately never gives up — `retryStrategy` returning a
 * number always means "try again".
 */
function retryStrategy(attempt: number): number {
  return Math.min(50 * 2 ** Math.min(attempt, 7), 5_000);
}

/**
 * ioredis raises this class of error when a command fails *because* of a
 * failover rather than because of anything the caller did; retrying is right.
 */
function reconnectOnError(err: Error): boolean {
  return /READONLY|ETIMEDOUT|ECONNRESET|EPIPE/.test(err.message);
}

function baseOptions(config: RedisConfig, role: string): RedisOptions {
  return {
    lazyConnect: true,
    retryStrategy,
    reconnectOnError,
    // Keep the TCP session warm through NAT/idle-timeout middleboxes; without
    // this a managed Redis behind a load balancer silently drops idle links.
    keepAlive: 30_000,
    // Queue commands issued while the socket is down instead of throwing, but
    // never wait forever — a hung command must not stall a turn.
    enableOfflineQueue: true,
    commandTimeout: config.commandTimeoutMs ?? 3_000,
    // Failing fast on boot is wrong here: we would rather come up degraded and
    // heal when Redis appears.
    maxRetriesPerRequest: 2,
    connectionName: `hcg-${role}`,
    ...(config.url.startsWith('rediss://') ? { tls: {} } : {}),
  };
}

function attachLogging(client: Redis, role: string): void {
  let downSince: number | null = null;

  client.on('error', (err: Error) => {
    // ioredis emits on every failed reconnect attempt; log the transition only.
    if (downSince === null) {
      downSince = Date.now();
      console.error(`[redis:${role}] connection error — degrading to local behaviour: ${err.message}`);
    }
  });

  client.on('ready', () => {
    if (downSince !== null) {
      console.log(`[redis:${role}] reconnected after ${Math.round((Date.now() - downSince) / 1000)}s`);
      downSince = null;
    }
  });

  client.on('end', () => {
    console.warn(`[redis:${role}] connection closed`);
  });
}

/**
 * Connects all three sockets. Resolves only once the command connection is
 * usable, so the caller can log a truthful "Redis connected" line; if the
 * initial connect fails the caller is expected to fall back to the in-memory
 * implementations rather than retrying here.
 */
export async function createRedisBundle(config: RedisConfig): Promise<RedisBundle> {
  const commands = new Redis(config.url, baseOptions(config, 'cmd'));
  const publisher = new Redis(config.url, baseOptions(config, 'pub'));
  const subscriber = new Redis(config.url, {
    ...baseOptions(config, 'sub'),
    // A subscriber has no request/response traffic to time out, and a timeout
    // here would tear down live subscriptions during a quiet period.
    commandTimeout: undefined,
    maxRetriesPerRequest: null,
  });

  for (const [client, role] of [
    [commands, 'cmd'],
    [publisher, 'pub'],
    [subscriber, 'sub'],
  ] as const) {
    attachLogging(client, role);
  }

  try {
    await Promise.all([commands.connect(), publisher.connect(), subscriber.connect()]);
    await commands.ping();
  } catch (err) {
    await Promise.allSettled([commands.quit(), publisher.quit(), subscriber.quit()]);
    throw err;
  }

  return {
    commands,
    publisher,
    subscriber,
    keyPrefix: config.keyPrefix ?? 'hcg',
    health(): RedisHealth {
      // ioredis statuses: connecting | connect | ready | close | reconnecting | end.
      // Only 'ready' can actually serve a command.
      return {
        healthy: commands.status === 'ready' && publisher.status === 'ready' && subscriber.status === 'ready',
        commands: commands.status,
        publisher: publisher.status,
        subscriber: subscriber.status,
      };
    },
    async close(): Promise<void> {
      // `quit` flushes in-flight commands; `disconnect` after a short grace
      // period covers a Redis that has stopped answering entirely.
      await Promise.allSettled([
        withTimeout(commands.quit(), 2_000),
        withTimeout(publisher.quit(), 2_000),
        withTimeout(subscriber.quit(), 2_000),
      ]);
      commands.disconnect();
      publisher.disconnect();
      subscriber.disconnect();
    },
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), ms);
      timer.unref?.();
    }),
  ]);
}

/** Reads Redis config out of the environment. Returns null when Redis is not configured. */
export function redisConfigFromEnv(env: NodeJS.ProcessEnv): RedisConfig | null {
  const url = env.REDIS_URL?.trim();
  if (!url) return null;
  return {
    url,
    keyPrefix: env.REDIS_KEY_PREFIX?.trim() || 'hcg',
    ...(env.REDIS_COMMAND_TIMEOUT_MS ? { commandTimeoutMs: Number(env.REDIS_COMMAND_TIMEOUT_MS) } : {}),
  };
}
