/**
 * Token-bucket rate limiting, used in two places:
 *
 *  - **Per WebSocket connection**, so one client cannot pin the event loop by
 *    firing thousands of `SUBMIT_MOVE`s a second. A bucket suits this better
 *    than a fixed window because normal play is bursty — you tap three cards
 *    quickly, then think for ten seconds — and a bucket forgives the burst as
 *    long as the *average* stays sane.
 *  - **Per IP on the auth endpoints**, where the thing being throttled is
 *    password guessing rather than event-loop pressure.
 *
 * The Redis implementation is a single Lua script so the read-modify-write is
 * atomic — two nodes checking the same bucket concurrently cannot both see it
 * as full. When Redis is unavailable the limiter falls back to its in-memory
 * bucket rather than failing open: a per-node limit is weaker than a global one
 * but far better than none.
 */

import type { RedisBundle } from '../redis/redis-client.js';

export interface RateLimitResult {
  readonly allowed: boolean;
  /** Tokens left after this call. */
  readonly remaining: number;
  /** How long until at least one token is available. 0 when allowed. */
  readonly retryAfterMs: number;
}

export interface RateLimitRule {
  /** Bucket size — the largest burst tolerated. */
  readonly capacity: number;
  /** Sustained rate, in tokens added per second. */
  readonly refillPerSecond: number;
}

export interface RateLimiter {
  consume(key: string, rule: RateLimitRule, cost?: number): Promise<RateLimitResult>;
  /**
   * Forgets a bucket, refilling it to capacity.
   *
   * The login limiter is the reason this exists. Throttling by IP is right —
   * password guessing is the threat — but a person who mistypes their own
   * password twice should not then be sharing a shrinking budget with whoever
   * else is behind the same NAT. Clearing the bucket on a *successful* login
   * costs an attacker nothing (they have no successes to spend) and gives the
   * legitimate user their full allowance back.
   */
  reset(key: string): Promise<void>;
}

// ---- In-memory --------------------------------------------------------------

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(sweepIntervalMs = 60_000) {
    // Buckets are created per key (per connection, per IP) and would otherwise
    // accumulate forever. A full bucket carries no information, so dropping it
    // is free.
    this.sweeper = setInterval(() => this.sweep(), sweepIntervalMs);
    this.sweeper.unref?.();
  }

  async consume(key: string, rule: RateLimitRule, cost = 1): Promise<RateLimitResult> {
    const now = Date.now();
    const bucket = this.buckets.get(key) ?? { tokens: rule.capacity, updatedAt: now };

    const refilled = Math.min(
      rule.capacity,
      bucket.tokens + ((now - bucket.updatedAt) / 1000) * rule.refillPerSecond,
    );
    bucket.updatedAt = now;

    if (refilled < cost) {
      bucket.tokens = refilled;
      this.buckets.set(key, bucket);
      return {
        allowed: false,
        remaining: Math.floor(refilled),
        retryAfterMs: Math.ceil(((cost - refilled) / rule.refillPerSecond) * 1000),
      };
    }

    bucket.tokens = refilled - cost;
    this.buckets.set(key, bucket);
    return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterMs: 0 };
  }

  async reset(key: string): Promise<void> {
    this.buckets.delete(key);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      // Idle long enough that it would have refilled completely anyway.
      if (now - bucket.updatedAt > 300_000) this.buckets.delete(key);
    }
  }

  stop(): void {
    clearInterval(this.sweeper);
  }
}

// ---- Redis ------------------------------------------------------------------

/**
 * Stores `tokens` and `updatedAt` in a hash and expires the key once it would
 * have refilled to full, so idle keys clean themselves up.
 *
 * Returns `{allowed, remaining, retryAfterMs}` as a flat array — Lua cannot
 * return floats, so times are rounded to whole milliseconds on the Redis side.
 */
const CONSUME_LUA = `
local key       = KEYS[1]
local capacity  = tonumber(ARGV[1])
local refill    = tonumber(ARGV[2])
local cost      = tonumber(ARGV[3])
local now       = tonumber(ARGV[4])

local state     = redis.call('HMGET', key, 'tokens', 'updatedAt')
local tokens    = tonumber(state[1])
local updatedAt = tonumber(state[2])

if tokens == nil then
  tokens = capacity
  updatedAt = now
end

local elapsed = math.max(0, now - updatedAt) / 1000
tokens = math.min(capacity, tokens + elapsed * refill)

local allowed = 0
local retryAfter = 0
if tokens >= cost then
  allowed = 1
  tokens = tokens - cost
else
  retryAfter = math.ceil(((cost - tokens) / refill) * 1000)
end

redis.call('HSET', key, 'tokens', tokens, 'updatedAt', now)
-- Live only as long as it takes an empty bucket to refill; after that the key
-- and a fresh one are indistinguishable.
redis.call('PEXPIRE', key, math.ceil((capacity / refill) * 1000) + 1000)

return { allowed, math.floor(tokens), retryAfter }
`;

export class RedisRateLimiter implements RateLimiter {
  private readonly prefix: string;
  private readonly fallback = new InMemoryRateLimiter();

  constructor(private readonly redis: RedisBundle) {
    this.prefix = `${redis.keyPrefix}:rl:`;
    this.redis.commands.defineCommand('hcgRateLimit', { numberOfKeys: 1, lua: CONSUME_LUA });
  }

  async consume(key: string, rule: RateLimitRule, cost = 1): Promise<RateLimitResult> {
    const scripted = this.redis.commands as unknown as {
      hcgRateLimit(key: string, capacity: string, refill: string, cost: string, now: string): Promise<[number, number, number]>;
    };
    try {
      const [allowed, remaining, retryAfterMs] = await scripted.hcgRateLimit(
        this.prefix + key,
        String(rule.capacity),
        String(rule.refillPerSecond),
        String(cost),
        String(Date.now()),
      );
      return { allowed: allowed === 1, remaining, retryAfterMs };
    } catch {
      // Degrade to a per-node limit rather than letting a Redis blip either
      // block every request or wave every request through.
      return this.fallback.consume(key, rule, cost);
    }
  }

  async reset(key: string): Promise<void> {
    // Clear both sides: the local fallback may hold a bucket built up while
    // Redis was unreachable, and leaving it there would keep penalising a user
    // who has just proved who they are.
    await this.fallback.reset(key);
    try {
      await this.redis.commands.del(this.prefix + key);
    } catch {
      /* the bucket expires on its own; a failed reset is not worth an error */
    }
  }

  /** Releases the fallback limiter's sweep timer. Called from the shutdown sequence. */
  stop(): void {
    this.fallback.stop();
  }
}

// ---- Rules ------------------------------------------------------------------

/**
 * Message budgets, sized from how the client actually behaves. A busy human
 * sends a handful of messages a second at most; the app-level heartbeat adds
 * one every 20s. Anything above these is a bug or an attack, and either way
 * deserves the same answer.
 */
export const WS_MESSAGE_RULE: RateLimitRule = { capacity: 40, refillPerSecond: 8 };

/** Room/match creation is cheap for the client and expensive for us — throttle it harder. */
export const WS_CREATE_RULE: RateLimitRule = { capacity: 5, refillPerSecond: 0.2 };

/** Login and register, per IP. Ten quick tries, then one every six seconds. */
export const AUTH_RULE: RateLimitRule = { capacity: 10, refillPerSecond: 1 / 6 };

/**
 * Password-reset requests, per IP. Far tighter than login because the cost
 * lands on someone else: every allowed request puts a real email in a real
 * inbox, so an open one turns this server into someone's spam cannon. Three,
 * then one every five minutes.
 */
export const PASSWORD_RESET_RULE: RateLimitRule = { capacity: 3, refillPerSecond: 1 / 300 };

/**
 * AI game-designer drafting calls, per *user* rather than per IP.
 *
 * Every allowed request spends seconds of LLM inference and thousands of
 * tokens from the same key pool the game seats play on, so an unthrottled
 * designer is a way to starve live matches of their AI turns. Keyed by user id
 * because the cost is attributable to an account: throttling by IP would put a
 * household or an office behind one shared budget for a feature that is
 * deliberately iterative.
 *
 * Six in a burst, then one every twenty seconds — a drafting call takes long
 * enough that a person cannot reach the sustained rate by typing, and the burst
 * covers the back-and-forth of getting a first draft right.
 */
export const DESIGN_RULE: RateLimitRule = { capacity: 6, refillPerSecond: 1 / 20 };
