# Redis in this project — every use, in depth

> What Redis is used for, why each use needs Redis specifically, the exact data structures and Lua involved, and what happens when Redis goes away. Verified against a real Redis Cloud instance on 2026-08-27 (`PROJECT_JOURNAL.md` §16).
>
> Companions: `SCALING.md` (the multi-node design at large), `DEPLOYMENT.md` (what to configure), `AUTH.md` (the session layer that uses the cache).

---

## 0. The premise: Redis is optional, and that is load-bearing

**With no `REDIS_URL`, this server runs exactly as it always has** — one process, everything in memory. Set it, and the *same build* fans out across as many instances as you like.

That works because **every Redis-backed component ships with an in-memory sibling behind an identical interface**:

| Interface | Without Redis | With Redis |
|---|---|---|
| `EventBus` | `LocalEventBus` | `RedisEventBus` |
| `OwnershipRegistry` | `LocalOwnershipRegistry` | `RedisOwnershipRegistry` |
| `RateLimiter` | `InMemoryRateLimiter` | `RedisRateLimiter` |
| `SessionCache` | `InMemorySessionCache` | `RedisSessionCache` |
| `ConnectionRegistry` | `LocalConnectionRegistry` | `RedisConnectionRegistry` |

`server.ts` picks one of each at boot, based on nothing more than whether `REDIS_URL` is set. Everything downstream — `MatchGateway`, `WsServer`, `AuthService` — is written against the interface and cannot tell which it got.

The point is not elegance. It is that **dev and prod run the same code path**. The alternative is two paths that drift, where the clustered one is only exercised in production and only fails there.

> **When you touch any of these five, change both implementations.** A behavioural difference between siblings is a bug that only appears when you scale up, which is the worst possible time to find it.

---

## 1. Why a card game needs this at all

For a normal REST API, running more instances is nearly free. Each request is self-contained: read the database, write the database, done. Any instance can serve any request because none remembers anything between them.

**This is the opposite.** A live match holds the dealt hands in one process's memory and runs its own AI-turn loop on a timer. It is stateful and *self-driving*.

Picture a card table with a dealer. If two dealers both think they're running table 7, they each shuffle their own deck and deal different cards to the same players — and both are certain they're right. That is precisely what happens if two instances both "serve" a match. It is not a subtle bug; it's the game coming apart.

Sticky sessions don't save you either: a player whose wifi blips reconnects with a brand-new socket that can land anywhere.

So Redis is doing **five distinct jobs**, and they are worth separating because only two of them are really about clustering:

| # | Job | Structure | Needs Redis because… | Without it |
|---|---|---|---|---|
| 1 | Match ownership leases | `STRING` + TTL | Two nodes must not own one match | Always "us" |
| 2 | Message bus | Pub/Sub | Nodes must reach each other at all | In-process |
| 3 | Rate limiting | `HASH` + TTL | A budget must not multiply by node count | Per-node |
| 4 | Session cache | `STRING` + TTL | A reconnect elsewhere should skip Mongo | Per-node |
| 5 | Connection counting | `ZSET` + scores | A per-account cap must not multiply | Per-node |

Jobs 1 and 2 are **correctness** — without them a multi-node deploy is broken. Jobs 3, 4 and 5 are **integrity and efficiency** — without them a multi-node deploy works but enforces limits N× looser than configured.

---

## 2. Connection management (`core/redis/redis-client.ts`)

### Three connections, not one

```ts
commands    // GET/SET/Lua — leases, rate limits, cache, connection counts
publisher   // PUBLISH only
subscriber  // locked into subscriber mode
```

This is not tidiness — **it is forced by the protocol.** A Redis connection in subscriber mode may only issue subscribe/unsubscribe commands. Once a socket is subscribed it cannot run `GET`. So pub/sub physically cannot share the socket that serves everything else.

The publisher is separate from `commands` because publishing while a command is in flight would interleave on one socket; keeping them apart means a slow command can't delay a state broadcast.

> **This matters for connection caps.** Each `RedisBundle` opens **three** sockets. Redis Cloud's free tier allows 30 concurrent connections, so ~10 backend instances. It's also why `redis-integration.test.ts` opens exactly two bundles for the entire suite — a bundle per test exhausts the allowance partway through and the rest fail with a misleading "Connection is closed".

### Failure policy: degrade, don't die

```ts
lazyConnect: true,
retryStrategy,               // 50ms → 5s, never gives up
reconnectOnError,            // retry on READONLY|ETIMEDOUT|ECONNRESET|EPIPE
keepAlive: 30_000,
enableOfflineQueue: true,
commandTimeout: 3_000,
maxRetriesPerRequest: 2,
```

Each line is a decision:

- **`retryStrategy` never returns anything but a number**, i.e. never gives up. A Redis that's been down for an hour might come back; a node that stopped trying never will.
- **`keepAlive: 30_000`** keeps the TCP session warm through NAT and idle-timeout middleboxes. Without it a managed Redis behind a load balancer silently drops idle links — and you discover it on the first move after a quiet period.
- **`enableOfflineQueue: true` with `commandTimeout: 3000`** is the pair that matters. Queue commands while the socket is down rather than throwing, *but never wait forever* — a hung command must not stall a player's turn. Queue, then give up.
- **`reconnectOnError` on `READONLY`** catches the managed-Redis failover case: a replica promoted to primary answers `READONLY` for a moment, and retrying is right where surfacing an error is not.
- **`rediss://` auto-enables TLS** by inspecting the URL scheme.

Error logging tracks the *transition*, not every attempt — ioredis emits `error` on every failed reconnect, and a server that's been unreachable for ten minutes would otherwise write thousands of identical lines.

### `health()` reads live status, and that is the whole point

```ts
health() {
  return {
    healthy: commands.status === 'ready'
          && publisher.status === 'ready'
          && subscriber.status === 'ready',
    ...
  };
}
```

`/ready` calls this on every probe. **Reporting "Redis: yes" because the *boot* succeeded is a lie with a long tail:** if Redis dies at 3am, a probe built on the boot-time answer keeps returning 200, and the load balancer keeps routing players to a node that can no longer see the rest of the cluster's matches. Reading ioredis's current status is a property access, not a round trip — cheap enough to do per probe.

Note `healthy` requires **all three**. A node whose subscriber died still answers commands but silently stops receiving state broadcasts, which is arguably worse than being fully down: it looks fine and serves stale tables.

### Key namespaces

Everything is prefixed with `REDIS_KEY_PREFIX` (default `hcg`), so one Redis can host several environments:

```
hcg:owner:<matchId>     lease         STRING, TTL
hcg:bus:<channel>       pub/sub       (channel name, not a key)
hcg:rl:<bucketKey>      rate limit    HASH, TTL
hcg:session:<token>     session cache STRING, TTL
hcg:conns:<userId>      connections   ZSET, TTL
```

---

## 3. Use 1 — Match ownership leases

**File:** `core/cluster/ownership-registry.ts` · **Structure:** `STRING` with a TTL, one key per match

The central problem from §1, solved directly: exactly one node owns a match at a time, and every command for it is routed there.

### Ownership is a lease, not a record

```
hcg:owner:<matchId>  =  "<nodeId>"     PX <leaseTtlMs>
```

The owner renews on a timer (`leaseTtlMs / 3`, so it renews about three times per lifetime — two renewals can be lost before the lease actually lapses).

**A lease rather than a permanent record, because nodes die.** If ownership were a durable row, a node that got SIGKILLed would leave its matches unreachable forever, and you'd need a reaper process to clean up — which then needs its own liveness detection, and you've built a distributed-systems problem to solve a distributed-systems problem. A TTL means a dead node's claims **expire on their own**, with no tombstones and nothing to clean up.

`MATCH_LEASE_TTL_MS` (default 30s) is the failover-speed dial: shorter means a crashed node's matches are adoptable sooner, at the cost of more renewal traffic.

### The three Lua scripts, and why each must be atomic

**Claim** — take it if free, and tell me who has it if not:

```lua
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then
  return ARGV[1]        -- we won; return our own id
end
return redis.call('GET', KEYS[1])   -- we lost; return the incumbent's
```

The single most important detail: **the loser gets the winner's node id back, not a boolean.** That return value is exactly what the gateway needs to know where to route the command. A `false` would force a second round trip, and worse, the owner could change between the two calls.

`SET NX PX` is itself atomic; the script exists so the failed case's `GET` rides in the same round trip.

> There's a genuine race the code handles explicitly: if the key's TTL expires between the `SET` and the `GET`, the `GET` returns nil. `claim()` treats nil as "we own it" — safe, because nobody holds a lease in that instant.

**Renew** — only while we're still the recorded owner:

```lua
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
```

**This compare-and-set is what makes the whole scheme safe.** Consider a node that pauses — GC, a hung disk, an overloaded host. Its lease expires. Another node adopts the match. The first node wakes up and renews. Without the CAS it would extend a lease it no longer holds, and **both nodes would believe they own the match** — the two-dealers scenario, arrived at through a stall rather than a crash.

A `false` return is not advisory. The owner must immediately stop acting as owner.

**Release** — the canonical safe-unlock:

```lua
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
```

Same reasoning in the other direction: a stale node shutting down gracefully must not delete a lease that now belongs to someone else. Without the guard, a slow node's tidy shutdown would evict the healthy owner.

### `defineCommand`, not `eval`

```ts
this.redis.commands.defineCommand('hcgClaimLease', { numberOfKeys: 1, lua: CLAIM_LUA });
```

ioredis then uses `EVALSHA` (sending a 40-char hash instead of the script body on every call) and **automatically falls back to `EVAL` on `NOSCRIPT`** — which is what happens after a Redis restart flushes the script cache. Hand-rolled `EVALSHA` without that fallback breaks on the first restart, at which point every lease operation fails at once.

### Verified

- lease goes to exactly one node, loser learns the winner's id
- renew works for the holder, **fails for a non-holder**
- release works for the holder, **is a no-op for a non-holder**
- a crashed node's lease expires and the match becomes adoptable
- a claim made on one connection is visible from another

Plus, end to end: node A killed mid-match with no graceful shutdown → node B waited out the lease and rebuilt from the durable snapshot (`[gateway] recovering match "…" from snapshot @ seq 7`).

---

## 4. Use 2 — The message bus

**File:** `core/cluster/event-bus.ts` · **Structure:** Pub/Sub

Owning a match is only useful if other nodes can *talk* to the owner. Two traffic shapes ride the bus:

### Fan-out — "here is the new state of match X"

```
channel:  hcg:bus:match:<matchId>
```

**Per-match, not one global firehose.** A node subscribes only to matches it actually has sockets watching, so a 10-node cluster doesn't multiply every state update by 10.

The security-relevant part: **the owner masks the state once per seat and publishes all the views together.** Every node then hands each of its sockets the right view. A node that doesn't own the match never has to compute a mask — and never sees a hand it shouldn't. Fog of war is applied at the source, once, by `core/obfuscation/fog-of-war.ts`.

### Request/reply — "you own match X, apply this move"

Redis Pub/Sub has no request/reply. `BaseEventBus` builds it:

```
node B                                     node A (owner)
  │ request(node:A:cmd, {...}, 5000)
  │   ├─ subscribe to reply:<uuid>  (its own private inbox, once)
  │   ├─ publish {id, replyTo, payload} ──────►│ handleRequests
  │   └─ start a 5s timer                      │ run the handler
  │                                            │
  │◄──────── publish {id, ok, value} ──────────┘ to replyTo
  └─ match id → resolve, clear the timer
```

Details that matter:

- **The reply inbox is per bus instance** (`reply:<uuid>`), subscribed lazily on first use. Replies never touch a shared channel, so no node parses another's traffic.
- **A late reply is dropped**, not resolved — the correlation id is gone from `pending` once the timeout fires.
- **The timer is `unref()`d**, so a pending request can't hold the process open during shutdown.
- **Remote errors are reconstructed as `RemoteError` carrying the original `name`.** `match-gateway.ts` branches on `remoteName` to rethrow the real class — `SeatTakenError` offers the player another seat, `NotHostError` doesn't. Losing the name would flatten every remote failure into a generic one and the UI would lose the ability to respond usefully.
- **A failed reply publish is logged, not retried.** The asker hits its own timeout, which is the correct outcome — the reason just shouldn't be lost.

### Reconnection

```ts
this.redis.subscriber.on('ready', () => {
  void this.redis.subscriber.subscribe(...this.handlers.keys());
});
```

ioredis replays subscriptions after a reconnect, but only for channels it still knows about. Re-asserting is cheap insurance against a node that silently stops receiving state for a live table — a failure with no error, where the game just appears to freeze.

### The local sibling does one non-obvious thing

```ts
const copy = JSON.parse(JSON.stringify(payload));
```

`LocalBusBackplane` **round-trips every payload through JSON** even though it's in-process. Without it, a local handler receives a live object reference where Redis would have delivered a copy — so a bug where a handler mutates a published payload would pass locally and corrupt state only in the clustered build. Making the local path *lossy in the same way* is what keeps it a faithful test double.

That's also how the cluster logic is tested without a server: two `LocalEventBus` instances sharing one `LocalBusBackplane` exercise identical routing code.

### Verified

publish crosses between connections; request/reply round-trips; a remote throw arrives as `RemoteError` with `remoteName` intact; a request to a channel nobody serves rejects with `RequestTimeoutError` rather than hanging.

---

## 5. Use 3 — Rate limiting

**File:** `core/ratelimit/rate-limiter.ts` · **Structure:** `HASH` + TTL

Token bucket — not a fixed window — because **normal play is bursty**: you tap three cards quickly, then think for ten seconds. A bucket forgives the burst as long as the average stays sane. A fixed window would either reject the burst or permit twice the rate across a boundary.

### Why this needs Redis

A per-IP budget of "10 login attempts" enforced per process becomes **10 × N** across N nodes. The attacker doesn't even need to do anything clever — the load balancer spreads their attempts for them.

### The Lua

```lua
local state     = redis.call('HMGET', key, 'tokens', 'updatedAt')
local tokens    = tonumber(state[1])
local updatedAt = tonumber(state[2])
if tokens == nil then tokens = capacity; updatedAt = now end

local elapsed = math.max(0, now - updatedAt) / 1000
tokens = math.min(capacity, tokens + elapsed * refill)

if tokens >= cost then allowed = 1; tokens = tokens - cost
else retryAfter = math.ceil(((cost - tokens) / refill) * 1000) end

redis.call('HSET', key, 'tokens', tokens, 'updatedAt', now)
redis.call('PEXPIRE', key, math.ceil((capacity / refill) * 1000) + 1000)
return { allowed, math.floor(tokens), retryAfter }
```

**Read-modify-write must be one atomic step.** Split into `HMGET` → compute → `HSET`, two nodes checking the same bucket concurrently both read a count taken before the other's write, and both allow. Under a distributed attack that is the *normal* case, not a rare race.

**Lazy refill** — no background job ticking every bucket. Tokens are computed from elapsed time on read, so an untouched bucket costs nothing.

**Self-expiring keys.** The TTL is exactly how long an empty bucket takes to refill completely, plus a second. After that, the key and a freshly created one are *indistinguishable*, so keeping it stores no information. Idle keys clean themselves up with no sweeper.

`math.max(0, now - updatedAt)` guards against clock skew between nodes — a negative elapsed would *remove* tokens.

Lua can't return floats, so times round to whole milliseconds on the Redis side and the result comes back as a flat `[allowed, remaining, retryAfterMs]` array.

### The buckets

| Rule | Capacity | Refill | Applied to |
|---|---|---|---|
| `WS_MESSAGE_RULE` | 40 | 8/s | Every WS message, per connection |
| `WS_CREATE_RULE` | 5 | 0.2/s | Room creation — cheap for the client, expensive for us |
| `AUTH_RULE` | 10 | 1 per 6s | Login/register, per IP |
| `PASSWORD_RESET_RULE` | 3 | 1 per 5 min | Reset requests, per IP |

Reset is throttled ~30× harder than login because **its cost lands on someone else** — every allowed request puts a real email in a real inbox, so an open endpoint makes this server someone's spam cannon.

`reset(key)` clears **both** Redis and the local fallback, since the fallback may hold a bucket accumulated while Redis was unreachable, and leaving it would keep penalising a user who just proved who they are.

### Verified

a shared bucket spends to empty and reports a positive `retryAfterMs`; **two separate connections count against one bucket**; refill works over real elapsed time; reset restores the full budget.

---

## 6. Use 4 — Session cache

**File:** `core/auth/session-cache.ts` · **Structure:** `STRING` + TTL · Full treatment in `AUTH.md` §4

Every WebSocket `AUTHENTICATE` — and every reconnect, of which there are many on flaky mobile — costs two Mongo round-trips (session, then user). Under a reconnect storm that's the slowest thing in the handshake, and it's entirely repeated work.

### Why Redis rather than per-node memory

A player reconnecting after a network blip **lands on a different node**. With per-node caches that's always a miss, so the cache helps least exactly when it's needed most — a mass reconnect after a deploy, when every player arrives at once on nodes that have never seen them.

Bulk revocation is the other half. `logoutEverywhere` and a password change must evict sessions **cluster-wide**; with per-node caches, a session revoked on node A keeps working on node B until its TTL.

### Three states, in one string

| Stored | Means | Effect |
|---|---|---|
| JSON `AuthUser` | Valid session | Serve it, no database |
| `" invalid"` sentinel | **Known-bad** token | Reject, **no database** |
| key absent | Not cached | Ask the database |

Caching *negative* results is what stops credential stuffing becoming a database flood: without it, every junk token is two Mongo reads, and 10,000 junk tokens a second is a DoS on your database rather than a failed login. This is why `null` and `undefined` had to be different values rather than a plain nullable.

60s positive, **10s negative** — negatives are cheap to re-derive and shouldn't outlive a mistake.

### Every operation swallows its errors

```ts
async get(token) {
  try { ... } catch { return undefined; }   // a cache that is down is a cache MISS
}
```

**Never an auth failure.** Losing Redis makes the server slower, not broken. `set` and `invalidate` are equally best-effort — and a failed `invalidate` is why the TTL is short: it bounds the blast radius of a revoked-but-cached token to one minute.

### Verified

a session cached on one connection is visible from another; miss and known-bad stay distinguishable; **invalidation on one connection is visible from the other** — the property bulk revocation depends on.

---

## 7. Use 5 — Cluster-wide connection counting

**File:** `core/cluster/connection-registry.ts` · **Structure:** `ZSET` (score = lease expiry)

`WsServer` caps sockets per account. Counting its own `Map` is the whole cluster only while there's one node — run four and **the cap silently becomes four times what it says**, so the runaway reconnect loop it was written to contain gets four times the file descriptors.

### The hard part is counting things that may already be gone

A SIGKILLed node never removes its entries. A permanent `+1` per crash would eventually **lock a user out of their own account** — a self-inflicted denial of service that heals only if someone notices and clears keys by hand.

So an entry isn't a flag, it's a **lease with an expiry**, and a sorted set is the natural fit: member = connection id, score = expiry timestamp. Every connection re-registers on the same heartbeat sweep that pings the socket, and expired entries are pruned at read time.

```lua
redis.call('ZREMRANGEBYSCORE', key, '-inf', now)   -- prune the dead
redis.call('ZADD', key, now + ttl, id)             -- add/refresh ours
redis.call('PEXPIRE', key, ttl + 5000)             -- whole key outlives its longest lease
return redis.call('ZCARD', key)                    -- count what's left
```

One script, four operations, because **prune-add-count must be atomic**: split across round trips, two nodes registering simultaneously both read a count taken before the other's insert and both conclude the user is under the cap.

`ZREMRANGEBYSCORE` with a score range of `-inf … now` is exactly "delete everything already expired" — the reason a sorted set beats a plain set here.

The `PEXPIRE` on the whole key is a detail worth keeping: without it, a user who never returns leaves an empty `ZSET` in Redis forever. `ttl + 5000` guarantees it outlives the longest lease it could hold.

`register` is **idempotent** — re-registering the same connection id is a heartbeat renewing its lease, not a new socket, so `ZADD` updates the score rather than adding a member.

### Degradation is different here, deliberately

```ts
catch { return this.fallback.register(userId, connectionId, ttlMs); }
```

Falls back to *this node's own count*. Weaker than a cluster-wide cap — but refusing every connection because Redis blinked would be far worse. **The cap exists to contain a reconnect loop, not to gate normal play**, and failing closed would turn a Redis hiccup into an outage.

### Verified

two connections on separate bundles count as 2; re-registering the same id stays 1; **a crashed node's entries age out and the count drops on its own**; a clean disconnect releases immediately.

---

## 8. What happens when Redis dies

The philosophy is uniform — *degrade, don't die* — but the specific degradation differs per use, and the differences are deliberate:

| Component | Redis unavailable | Consequence |
|---|---|---|
| `SessionCache` | Treat as cache miss | Slower auth; every handshake hits Mongo |
| `RateLimiter` | Local bucket | Per-node limits — N× looser, still bounded |
| `ConnectionRegistry` | Local count | Per-node cap — N× looser |
| `EventBus` | Publish rejects | **Cross-node routing stops** |
| `OwnershipRegistry` | Claim/renew reject | Gateway assumes local ownership |

The first three are graceful. The last two are not, and can't be: if nodes can't reach each other, there is no correct single-node answer.

That's why **`/ready` returns 503 when Redis is unhealthy** — the node takes itself out of the load balancer rather than serving traffic it can't route. And why, at boot:

```ts
if (IS_PRODUCTION) {
  throw new Error(`REDIS_URL is set but Redis is unreachable, and NODE_ENV=production`);
}
```

**`REDIS_URL` being set in production means someone is running more than one instance.** Booting without Redis would silently split the cluster into nodes that can't see each other's matches — every one of them convinced it's fine. Refusing to start is far better. In development the same failure prints a warning and falls back, because there the fallback is genuinely correct.

Note the gateway's `.catch(() => this.nodeId)` on claim, and `.catch(() => true)` on renew: **when Redis can't answer, assume we still own what we own.** Dropping matches on a transient blip would be worse than briefly risking a split, and the lease TTL bounds how long that risk lasts.

---

## 9. Operating notes

### Sizing

Redis holds almost nothing here. Per live match: one lease key (~50 bytes). Per active user: one cache entry (~200 bytes) and one small ZSET. Per active IP: one rate-limit hash. **A thousand concurrent players is comfortably under a megabyte.** Redis is used for coordination, not storage — matches persist to Mongo, not Redis.

Connections are the real constraint: **3 per instance**. Redis Cloud's free tier allows 30, so ~10 instances.

### Use `rediss://`

`redis://` to a remote host carries session tokens and match state **in clear text across the public internet**. `validateEnv` warns at every boot. Managed providers publish a TLS endpoint for the same database — on Redis Cloud it's the same host on a different port, under the database's Security settings. `redis-client.ts` enables TLS automatically from the scheme; nothing else changes.

### Running the integration suite

```bash
# Skipped entirely unless REDIS_TEST_URL is set, so the default run stays offline.
cd backend && npx vitest run redis-integration
```

21 cases. Every key is written under a prefix unique to the run and deleted afterwards, so a shared database is safe to point at — though a throwaway one is still the better idea.

### Multi-environment

`REDIS_KEY_PREFIX` (default `hcg`) namespaces everything, so staging and production can share one Redis without colliding. They will still share **connection limits and memory**, so it's a convenience, not an isolation boundary.

### What to watch

| Signal | Meaning |
|---|---|
| `[redis:cmd] connection error` | Degrading to local behaviour |
| `[redis:*] reconnected after Ns` | Recovered; N tells you how long you were split |
| `[gateway] recovering match … from snapshot` | A node died and this one adopted its match — **working as designed** |
| `[bus] failed to restore subscriptions` | Serious: this node may be silently missing state updates |
| `/ready` → 503 with `redis.healthy: false` | The node removed itself from the pool |

---

## 10. Summary

| Use | Structure | Atomicity | Fails to |
|---|---|---|---|
| Ownership leases | `STRING` + TTL | 3 CAS Lua scripts | Assume local ownership |
| Message bus | Pub/Sub | n/a (correlation ids) | No cross-node routing |
| Rate limiting | `HASH` + TTL | 1 Lua script | Per-node buckets |
| Session cache | `STRING` + TTL | n/a (idempotent) | Cache miss |
| Connection counting | `ZSET` + TTL | 2 Lua scripts | Per-node count |

**The recurring pattern, worth stating once:** every multi-step read-modify-write is a Lua script, because Redis runs Lua atomically and the alternative — separate round trips — is a race that only manifests under exactly the concurrency the feature exists to handle. And every use has an in-memory sibling, because a code path that only runs in production is a code path that only fails in production.
