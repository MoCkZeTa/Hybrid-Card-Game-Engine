# Deploying this server

> Companion to `SCALING.md` (how the multi-node layer works), `REDIS.md` (what Redis is actually doing), `AUTH.md` (how authentication works) and `PROJECT_JOURNAL.md` (why anything is the way it is). This file is the operational one: what to set, what to run, and which failures look like success.

Everything here has been run. Where a step says "verified", it means it was actually executed against the real dependency — see §16 of `PROJECT_JOURNAL.md` for what that pass found.

---

## 1. Build and run

```
npm install
npm run build      # shared -> backend -> frontend, IN THAT ORDER
npm start          # node backend/dist/server.js
```

**The build order is mandatory, not stylistic.** `backend` and `frontend` resolve `@hcg/shared` to `shared/dist/*.d.ts`. Building out of order compiles them against the *previous* build's types. The same trap applies to `npm run typecheck`, which never regenerates `dist/` at all — a clean typecheck of `backend` means nothing until `shared/dist` is current.

The backend build also copies `src/games/` into `dist/games/` (`backend/scripts/copy-games.mjs`). `tsc` compiles `.ts` and nothing else, but a game plugin is a *folder* — `rules.json` plus `strategy.md` — and the compiled server scans `dist/games/`. Without that step the server starts and immediately dies with `ENOENT ... dist\games`.

Node 20.11+ is required (`engines` in the root `package.json`).

---

## 2. Environment

`backend/src/config/env.ts` is the authority: it inspects the environment at boot, warns about anything questionable, and **refuses to start** when `NODE_ENV=production` and something is wrong. That inversion is the whole design — every optional dependency in this server degrades quietly, which is right in development and indistinguishable from working in production.

Copy `.env.example` to `.env` at the **repo root** (not `backend/`) — `server.ts` loads it from there regardless of which workspace's script is running.

### Required in production

| Variable | Why it is fatal without it |
|---|---|
| `MONGODB_URI` | No database means accounts, matches and imported plugins live in memory. The process looks healthy until the first restart takes every account with it. |
| `CORS_ORIGIN` | Also builds the WebSocket origin allowlist, which is the defense against cross-site WebSocket hijacking. Must not be `*` and must not be localhost. |
| `APP_BASE_URL` | The public origin of the **client** — what password-reset links point at. Unset, reset emails link to `localhost:5173`. |
| `RESEND_API_KEY` | Without it, reset links print to a console nobody reads and the user simply never gets their email. Set `ALLOW_CONSOLE_EMAIL=true` to accept that deliberately. |

### Strongly recommended

| Variable | Effect if unset |
|---|---|
| `GROQ_API_KEYS` | Not fatal, by design: every AI turn falls back to `legal_moves[0]`. The game runs, and plays badly. The boot banner says `AI provider: groq (unconfigured)` and every fallback names the missing key in the decision log. |
| `REDIS_URL` | Single-node only. See §4. |
| `TRUST_PROXY` | Set `true` **only** behind a proxy you control. It makes the server believe `X-Forwarded-For`; anywhere else a client can spoof that header and walk past the per-IP rate limit. |
| `DESIGNER_MAX_TOKENS` | Defaults to 8000, which is right on a paid LLM tier and **too large on a free one**: Groq reserves `max_tokens` against your per-minute token budget up front, so on an 8000 TPM key every drafting call is refused with a 413 before generating anything. Set `3200` there. Below ~2000 first drafts truncate mid-JSON. See `GAME_DESIGNER.md` §7. |
| `DESIGNER_MODEL` | Defaults to `openai/gpt-oss-120b` (Groq) / `gemini-2.0-flash` (Gemini). Resolved lazily at call time, so a model your account cannot reach surfaces as a clean 502 on the first draft rather than a failed boot — worth checking against `/v1/models` before you rely on it. |

`PORT`, `WS_HEARTBEAT_MS`, `WS_MAX_CONNECTIONS`, `LLM_TIMEOUT_MS`, `MATCH_LEASE_TTL_MS`, `DESIGNER_TIMEOUT_MS`, `DESIGNER_MAX_TOKENS` and `REDIS_COMMAND_TIMEOUT_MS` are validated as positive numbers and are **fatal in any environment** if malformed — `Number('30s')` is `NaN`, which silently becomes a timer that never fires.

---

## 3. Single-origin vs split-origin

### Single-origin (recommended)

Set `SERVE_STATIC=true`. One process serves the API, the WebSocket and the built client on one port.

```
SERVE_STATIC=true
CORS_ORIGIN=https://play.example.com
APP_BASE_URL=https://play.example.com     # same value
```

This removes a whole class of problem: no separate frontend deploy, no CORS to configure, no second origin on the WebSocket allowlist, and the socket connects back to the exact origin that served the page. **Do not set `VITE_WS_URL`** when building the client for this — the bundle derives its origin from `window.location` at runtime, using `wss:` when the page is `https:`.

`http/static-files.ts` handles two details that matter more than they look:

- **SPA fallback.** A password-reset link opens `/reset-password?token=…` *cold*. The server has to answer a path that is not a file with `index.html`, or the link is dead.
- **Two cache policies.** `/assets/*` is content-hashed by Vite and immutable for a year; `index.html` is `no-cache`, because it is what names the current bundle. Getting this backwards pairs a freshly cached page with a deleted bundle.

### Split-origin

Client on a CDN or static host, backend elsewhere. Then:

- build the client with `VITE_WS_URL=wss://api.example.com`
- set the backend's `CORS_ORIGIN` to the **client's** origin, or the WebSocket upgrade is refused with a 403
- `APP_BASE_URL` is still the client's origin

---

## 4. Running more than one instance

Set `REDIS_URL` and give each instance a `NODE_ID`. Without `REDIS_URL` the process runs single-node with everything in memory, and **running two of those is silent corruption** — each would deal its own cards for the same match and both would believe they were right.

```
REDIS_URL=rediss://…            # prefer TLS; see the warning below
NODE_ID=web-1                   # optional, but makes logs readable
MATCH_LEASE_TTL_MS=30000        # shorter = faster failover, more Redis traffic
```

With `NODE_ENV=production`, `REDIS_URL` being set and Redis being unreachable is a **hard startup failure**. Coming up as an isolated node that cannot see the rest of the cluster's matches is worse than not starting.

Every Redis use, its data structure, its Lua, and how it behaves when Redis is unreachable is documented in `REDIS.md`.

> **Use `rediss://`, not `redis://`.** An unencrypted connection to a remote Redis carries session tokens and match state in clear text across the public internet. `validateEnv` warns about this at boot. Managed providers publish a TLS endpoint for the same database — on Redis Cloud it is the same host on a different port, under the database's Security settings.

### Load balancer

| Probe | Meaning | Use it for |
|---|---|---|
| `GET /health` | The process is alive. Never fails while it can answer. | Liveness / restart policy |
| `GET /ready` | Traffic should be sent here. `503` while draining, **and `503` if Redis has died since boot.** | Readiness / removing from the pool |

That second clause is the one worth understanding: Redis health is read live rather than reported from the boot-time outcome. A node whose Redis connection has died can no longer see the rest of the cluster's matches, and a probe that keeps answering `200` because the *connect* succeeded hours ago is exactly how a balancer keeps feeding it traffic it cannot serve.

Sticky sessions are **not** required and do not help — a reconnecting WebSocket can land on any node, and `MatchGateway` routes commands to whichever node holds that match's lease.

### Shutdown

`SIGTERM`/`SIGINT` drains in a deliberate order (`lifecycle/shutdown.ts`): stop advertising readiness → close WebSocket clients so they reconnect elsewhere immediately → hand back match ownership so a surviving node can adopt → close the HTTP server → close the event bus → close Redis and Mongo last, so in-flight persistence writes land. Give the container at least 15s to stop.

**Failover does not depend on a clean shutdown.** A hard-killed node never releases its lease; the lease simply expires after `MATCH_LEASE_TTL_MS` and another node rebuilds the match from its last durable snapshot. Verified by killing a node mid-match — see §16 of the journal.

---

## 5. Email

**`onboarding@resend.dev` only delivers to the email address on your own Resend account.** Every other recipient is rejected. It is enough to prove the flow works end to end and **not** enough to ship: with it in place, password reset silently fails for every real user, and it fails quietly by design — `requestPasswordReset` swallows send errors (logging them) so the endpoint cannot be used to discover which addresses are registered.

Before real users:

1. Add a domain at <https://resend.com/domains>.
2. Copy the DKIM/SPF records it shows into your DNS.
3. Wait for it to read *verified*.
4. Set `EMAIL_FROM=noreply@yourdomain.com`.

Until then, `[auth] failed to send reset email` in the logs is the only signal you get.

---

## 6. Post-deploy checklist

```bash
curl https://your-host/health          # {"status":"ok",...}
curl https://your-host/ready           # ready:true, redis.healthy:true, mongo:true
```

Then, in a browser:

1. Register, sign out, sign back in.
2. **Forgot password → receive the email → open the link → set a new password.** This path has the most moving parts (mail provider, `APP_BASE_URL`, SPA fallback, single-use token) and is the one most likely to be broken by a config mistake.
3. Open the account panel (click your name in the lobby): change password, check the session count, sign out other devices.
4. Create a match, play a hand, confirm the AI seats actually reason — if the boot banner said `groq (unconfigured)` they will just play their first legal move.
5. Hard-refresh mid-match and confirm you get your seat back.
6. Open **"Design a game with AI"** in the lobby and draft something simple. If the panel is not there at all, this server has no LLM key — `curl https://your-host/api/design` reports `available:false` and the reason. A draft that comes back "Plays correctly" means the server dealt and played a real match of it, so publishing it is safe.

For a multi-node deploy, also confirm a match created against one instance is playable after the balancer moves you to another. The simplest check is to restart one instance mid-match and keep playing.

---

## 7. Security notes

- Session tokens live in `localStorage`, not cookies. That is deliberate: a hijacked cross-site socket has nothing to authenticate with. It also means CSRF is not a concern here, and XSS is correspondingly more serious. The full reasoning — and why the split-origin option in §3 would be painful with cookies — is in `SESSION_TRANSPORT.md`.
- Passwords use Node's built-in `scrypt`, with the cost parameter embedded in each stored hash so it can be raised later without invalidating existing accounts.
- Reset tokens are stored as SHA-256, so a database dump contains no usable links.
- Rate limits are per-IP and shared across the cluster via Redis. Without Redis they are per-instance, so N instances means N× the intended budget.
- **Rotate any credential that has ever been in a plaintext `.env`, a chat log, or a screen share.** See the open item in `PROBLEMS.md`.
- Every item above is explained in full in `AUTH.md`, including the threat model and what it deliberately does *not* cover (no email verification, no 2FA, no per-account lockout).
