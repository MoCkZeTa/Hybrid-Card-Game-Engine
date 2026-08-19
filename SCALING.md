# Running this thing for real

Notes on the realtime layer: what protects it, what Redis is for, and what to
set when you move off one laptop.

## The short version

Nothing here is required to run locally. With no `REDIS_URL`, the server boots
as a single node with everything in memory — the same as it always did. Every
Redis-backed component has an in-memory sibling behind the same interface, so
there is one code path, not a "dev mode" and a "prod mode" that drift apart.

Set `REDIS_URL` when you want more than one backend instance.

## Why a card game can't just be load-balanced

Most web backends scale by being stateless: any instance can serve any request.
A live match is the opposite. It holds four dealt hands in memory and runs an AI
turn loop on a timer. Two instances "serving" the same match would deal two
different next hands and both be convinced they were right.

You also cannot insist all four players land on the same instance. A load
balancer will scatter them, and sticky sessions do not survive a reconnect.

So the model is **one owner per match, and commands travel to the owner**:

```
browser ──ws──> node B ──redis request/reply──> node A (owns the match)
                                                  │ applies the move
browser <──ws── node B <──redis pub/sub──────────┘ publishes the new state
```

Ownership is a **lease** — a Redis key with a TTL that the owner renews on a
timer, not a permanent record. If a node dies its leases simply expire, and the
next node to be asked about that match takes it over, rebuilding state from the
durable snapshot that `AsyncPersistenceWriter` has been writing after every
move. No tombstones to clean up, no match stranded on a process that is gone.

Two things are deliberately *not* recovered on failover, because neither is
persisted and neither can be guessed safely: **seat claims** (every seat starts
unclaimed and plays as AI until its owner reconnects — losing a couple of turns
beats handing someone's hand to whoever asks first) and **the RNG stream**
(reseeded; only future deals differ, which no player can observe).

Fan-out is per-match rather than one global firehose, and the owner masks the
state once per seat before publishing. A node that does not own a match never
receives another player's cards for it.

`core/cluster/match-gateway.test.ts` exercises all of this — routing, fan-out,
presence, failover, and the recovery race — with several `MatchGateway`s sharing
one in-process backplane, which drives the same code the Redis transport does.

## Presence, and the crashed-node problem

A seat only blocks the AI while its player has a live connection. In one process
that is just socket `close` events. Across nodes it cannot be, because a node
that is killed outright never fires one — and its connections would pin their
seats away from the AI forever.

So every node re-asserts its live connections to each match's owner on a timer,
and the owner drops anything from a node it has not heard from in
`presenceTtlMs`. A lost `close` event heals on the next tick instead of stalling
a table.

If every seat's owner is gone at once — not just one seat falling to AI, but
nobody connected to the match at all — the turn loop keeps that fact on a
clock instead of playing the match out unattended: an empty table never has a
human seat to block on, so left alone it would run AI vs AI to the end of the
match by itself. Once the empty stretch outlasts `noHumanTimeoutMs` (default
120s — long enough to survive a refresh or a flaky reconnect), the loop stops
advancing the match and the owning node releases it immediately, with no
result-screen grace period, since there is nobody to show one to. A human
reconnecting at any point before that resets the clock and the match picks up
right where it left off.

## Game plugins across nodes

Built-in games (29, Callbreak) ship as files under `backend/src/games/` and are
read once at boot on every node — nothing to synchronize, they're identical
server code everywhere.

A user-*imported* plugin (`POST /api/plugins`) is different: it's written
through to `PluginRepository` (Mongo-backed when `MONGODB_URI` is set, an
in-memory map otherwise — same pattern as `MatchRepository`/`UserRepository`),
not to any node's local disk, precisely so it isn't tied to whichever node
happened to receive the import. Each `PluginManager` keeps an in-memory cache
in front of that repository — checked first, falling back to one repository
read on a miss — so a request that lands on a node which never saw the import
still resolves it correctly instead of reporting "unknown game." Imported
plugins are also private to their importer: `getVisible(gameId, userId)` is
the only path that resolves one, and it enforces ownership on every call,
cache hit or miss. Joining an already-created match by its `matchId` needs
none of this — the owning node already holds that match's plugin reference —
which is what lets a friend join and play via a shared match code without any
plugin visibility of their own. See `PROJECT_JOURNAL.md` §11.

## What the socket layer defends against

| Threat | Defence |
| --- | --- |
| Dead connections (lid closed, wifi lost, proxy dropped an idle tunnel) | RFC 6455 ping/pong every `WS_HEARTBEAT_MS`; a missed round terminates the socket and frees the seat |
| The same, from the browser's side — `readyState` stays OPEN long after a link dies, and browsers cannot send ping frames | Application-level `PING`/`PONG` in the protocol, sent by the client every 20s |
| Cross-site WebSocket hijacking — the same-origin policy does **not** cover WebSockets | Origin allowlist enforced at the upgrade, before any socket state is allocated |
| Slow consumers buffering state updates in our heap forever | Sockets more than 1 MiB behind are dropped; they reconnect and resync |
| Unauthenticated squatters | 10s handshake window, then closed |
| Message floods | Per-connection token bucket, plus a 16 KiB frame cap enforced by `ws` before buffering |
| Password guessing | Per-IP token bucket on `/api/auth/login` and `/register`, shared across nodes via Redis |
| Connection storms | Global and per-user connection caps |
| A crash taking the process down silently | `error` handlers on every socket; `uncaughtException`/`unhandledRejection` logged before exit |

Close codes live in `shared/src/protocol.ts` (`WS_CLOSE`). The client branches on
them: `AUTH_FAILED` is terminal and signs the user out, everything else
reconnects.

## Reconnection

`useGameConnection.ts` reconnects with exponential backoff and **full jitter**.
The jitter matters more than it looks: without it, a server restart brings every
client back at the same instant and the herd knocks it over again.

On reconnect the client re-sends its last `ENTER_ROOM`/`JOIN`. Both are
idempotent server-side and answer with a full snapshot, so the player lands back
at the table rather than in the lobby. It also reconnects on `online`, `focus`,
and `visibilitychange` — a laptop resuming from sleep almost always has a stale
socket, and checking immediately beats waiting for the next heartbeat.

## Deploying

Health probes:

- `GET /health` — liveness. Answers while the process is up.
- `GET /ready` — readiness. Flips to 503 the moment shutdown starts, which is
  the signal for the balancer to stop routing new connections here.

On SIGTERM the server drains in order: stop reporting ready → wait for the
balancer to notice → close every socket with `GOING_AWAY` (so clients reconnect
at once rather than waiting out a heartbeat) → release match ownership (so a
surviving node adopts those matches immediately rather than after the lease
expires) → close Redis and Mongo. The whole sequence is bounded; a hung step
does not turn into a hung shutdown.

Behind a proxy, set `TRUST_PROXY=true` **only** if you control it. Otherwise a
client can spoof `X-Forwarded-For` and dodge the per-IP auth rate limit.

### Minimum multi-node config

```
REDIS_URL=rediss://…
MONGODB_URI=mongodb+srv://…
NODE_ENV=production
CORS_ORIGIN=https://your-domain
TRUST_PROXY=true
```

In production, `REDIS_URL` being set while Redis is unreachable is a hard
startup failure — coming up as an isolated node that cannot see the rest of the
cluster's matches is worse than not starting. Locally it just logs and falls
back to single-node.

## What is not done

- **The Redis-backed classes have no integration test against a real Redis.**
  Their logic is covered through the in-memory siblings and the local backplane,
  which run the identical routing code, but the Lua scripts and ioredis wiring
  have not been executed against a live server. Run one before you trust a
  multi-node deploy.
- Sessions are still opaque random tokens in Mongo (now cached). If you want
  stateless auth across nodes without the Mongo read at all, that is a JWT
  change, not a Redis one.
