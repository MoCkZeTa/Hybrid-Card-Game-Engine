# Problems & Solutions Log

> Concrete obstacles hit while building this project, why they happened, and how they were resolved (or why they're still open). This is the "what went wrong and what we did about it" companion to `PROJECT_JOURNAL.md` (which covers "what we chose and why" more broadly). Add a new entry here any time something breaks, surprises you, or requires a workaround — don't let the fix live only in a code comment or a chat transcript.

Format per entry: **Problem** → **Root cause** → **Fix / current status**.

---

## Security & WebSocket transport

### XSS Vulnerability due to LocalStorage
**Problem:** To prevent Cross-Site WebSocket Hijacking, session tokens are stored in `localStorage` instead of cookies. This makes the application immune to CSRF but exposes the tokens directly to any injected malicious scripts (XSS).
**Root cause:** `localStorage` is accessible to JavaScript on the same origin.
**Fix (resolved):** Injected a strict `Content-Security-Policy` header in `backend/src/http/static-files.ts` to restrict resource loading and mitigate inline script execution.

### Rate Limit Spoofing via X-Forwarded-For
**Problem:** The server trusts `X-Forwarded-For` unconditionally if `TRUST_PROXY=true` is set. If not behind a real proxy, an attacker can spoof this header to bypass per-IP rate limits.
**Root cause:** Blindly trusting proxy headers outside a controlled network boundary.
**Fix (resolved):** Added `TRUST_PROXY=false` as the explicit default in `.env.example` with a stern warning.

### Cross-site WebSocket hijacking
**Problem:** the browser's same-origin policy — which protects `fetch`/XHR — does **not** apply to WebSocket connections. Any page on the internet can open `ws://your-server` from inside a victim's browser.
**Root cause:** WS is exempt from same-origin policy by spec; relying on it for socket security was never going to work.
**Fix (resolved):** `Origin` header is checked against an allowlist at the HTTP *upgrade*, before any socket state is allocated (`backend/src/ws/origin.ts`). As a second layer, the session token lives in Web Storage, not a cookie — a hijacked cross-site socket has nothing to authenticate with even if origin checking were somehow bypassed. Non-browser clients (no `Origin` header at all — CLI tools, load tests) are allowed through, since the whole threat model is "victim's browser rides on the victim's session," which doesn't apply to them.

### Browsers can't send native WebSocket ping frames
**Problem:** `readyState` on a browser WebSocket can stay `OPEN` long after the underlying connection is actually dead (wifi drop, proxy silently closed an idle tunnel), and browsers have no API to send an RFC 6455 ping frame to proactively check.
**Root cause:** platform limitation, not something server-side heartbeat logic alone can detect from the client's side.
**Fix (resolved):** added an application-level `PING`/`PONG` message pair in the wire protocol (`shared/src/protocol.ts`), sent by the client every 20s, on top of the server's real RFC 6455 ping/pong. A missed round on either side terminates the connection and frees the seat.

### Thundering herd on reconnect after a server restart
**Problem:** a plain exponential backoff reconnect strategy brings every disconnected client back online at (roughly) the same moment after a restart, which can immediately re-topple a server that just came back up.
**Root cause:** exponential backoff alone is deterministic across clients that all disconnected at the same instant.
**Fix (resolved):** added **full jitter** to the reconnect backoff in `frontend/src/useGameConnection.ts` — the randomization matters more than the backoff curve itself here.

---

## Auth & sessions

### A closed tab came back signed in as a different player
**Problem:** during two-account playtesting, `rahuljain`'s tab was closed and reopened — and the app came up signed in as `mockzeta`, with a live seat at the table. No sign-in screen, no prompt, no error. Clearing `localStorage` fixed it instantly, which made the cause *less* obvious rather than more: every function in the path was correct.
**Root cause:** the session was a **browser-wide singleton**. `localStorage` is scoped to the origin rather than the tab, holds exactly one value per key, and never expires on its own — while the token inside it is valid for 7 days with sliding renewal (`auth-service.ts:31-33`). So a token written days earlier by a different person was still valid, still present, and restored on open with nothing indicating whose it was. The restore path (`App.tsx`) did exactly what it was built to do: read the token, ask `/api/auth/me` who it belongs to, adopt that identity. The server answered honestly. It was simply never asked the question the user cared about — *is this who I meant to be?* The same singleton also made it impossible to hold two accounts in one browser at all, which is what pushed testing into two browsers and produced the confusion in the first place. Audited and **ruled out** before changing anything: token collision (`randomBytes(32)`), a shared session from `login()`, an unfiltered Mongo session lookup, a loosely-keyed `SessionCache`, a stale token captured in the socket reconnect closure, and a second write path for the key. A live probe against the running server confirmed two registrations get distinct tokens, each resolving to its own account.
**Fix (resolved):** the **tab** owns the session now. `sessionStorage` is authoritative and per-tab; `localStorage` is opt-in persistence only, behind a "Keep me signed in on this browser" checkbox, and is consulted solely to seed a tab that has no session of its own — which that tab then *adopts* into its own `sessionStorage`, pinning it so no other tab can move it. Signing in without the box **clears** the shared slot rather than leaving it, so a previous account's token can never lie in wait for the next cold start. Storage reads/writes are wrapped against browsers that throw on Web Storage (Safari private mode, blocked site data), which also fixed an unrelated latent white-screen at boot. Full write-up, including the behaviour matrix and what this deliberately does *not* fix: **`SESSION_PERSISTENCE.md`**.
**Lesson worth keeping:** "cleared the cache and it went away" was the correct remedy and a near-useless diagnosis — the defect was in a system property no single function owned. And the detail that sounded impossible (*"the token is the same in both browsers"*) was not a false report but a **consequence of the design being unobservable**: with identity restored silently, a user cannot see which session they are in, so they describe the symptom instead of the state.

---

## AI / Groq integration

### Groq reasoning models return a 400 "Failed to validate JSON" that looks like a bad request but isn't
**Problem:** with `response_format: json_object`, a reasoning-capable Groq model (e.g. `openai/gpt-oss-120b`) sometimes spends its entire `max_tokens` budget on hidden chain-of-thought and gets cut off before ever emitting the closing brace of the JSON answer — Groq reports this as a 400, which looks identical to a genuinely malformed request.
**Root cause:** `max_tokens` budget too small relative to how much hidden reasoning the model does at a given `reasoning_effort`.
**Fix (resolved):** `maxTokensFor()` in `backend/src/core/ai/groq-provider.ts` scales the token budget by `reasoning_effort` (500 for plain chat models, up to 3500 for `high`). Additionally, this *specific* 400 (matched by message text, `/failed to validate json/i`) is treated as retryable on another key rather than a hard failure — a fresh attempt often samples a shorter chain-of-thought and finishes in time, unlike a truly malformed request which fails identically every time.

### `GROQ_MODEL` set to a plain chat model silently broke Medium/Hard/Extremely Hard bots
**Problem:** every AI turn at Medium/Hard/Extremely Hard failed with `groq provider failed: Groq API returned 400 Bad Request: {"error":{"message":"reasoning_effort is not supported with this model"...}` and fell back to `legal_moves[0]` — Easy played normally, so it looked like the other three difficulty levels were simply unimplemented rather than a config bug. Root-caused by reproducing the exact failure via real (non-mocked) Groq API calls through the actual `createBotTiersFromEnv`/`GroqProvider` code path for all four levels, then confirming the fix the same way.
**Root cause:** `.env`'s `GROQ_MODEL` was `llama-3.1-8b-instant`, a plain (non-reasoning) chat model. `createBotTiersFromEnv` (`provider-router.ts`) shares one model across all four `BotLevel` tiers by design and only varies `reasoning_effort` (see `PROJECT_JOURNAL.md` §3.6) — so this is only ever a working setup if the configured model actually supports that field. Groq rejects `reasoning_effort` outright for non-reasoning models, and per `groq-provider.ts`'s retry policy a plain 400 (unlike the "failed to validate json" 400 below) is *not* retried on another key, so the very first call fails and the turn falls back — silently, with no startup-time signal that the four difficulty levels aren't actually differentiated. `.env.example`'s default (`llama-3.3-70b-versatile`) had the identical bug for anyone following it fresh.
**Fix (resolved):** `GROQ_MODEL` in both `.env` and `.env.example` changed to `openai/gpt-oss-120b`, a Groq-hosted reasoning model that accepts `reasoning_effort`. Verified with real API calls (not mocks) across all four levels both before the fix (reproduced the exact 400 above for medium/hard/extreme) and after (16 real calls across 4 runs, all four levels returning valid moves well inside their timeout budgets — easy ~0.9s/1.5s budget, extreme ~1.0-1.4s/10s budget). `openai/gpt-oss-20b` also works if a cheaper/faster model is ever wanted instead. `.env.example` gained a comment stating the reasoning-capable-model requirement explicitly, next to the field, so this can't quietly recur for a fresh setup.

### The AI was instructed to count cards it was never shown
**Problem:** both shipped `strategy.md` files tell the bot to track the hand — 29's *"Track which point cards (J, 9, A, T) have already fallen"*, Callbreak's *"count exactly who holds which remaining card in each suit"* — and neither was possible. Bots played measurably worse than their own strategy guide described, with nothing anywhere reporting a problem.
**Root cause:** two layers, both invisible on their own. `GameState` kept only `currentTrick` and `lastTrick`, and `lastTrick` existed for a client *animation* (the engine clears `currentTrick` in the same transition that plays the final card, so without it the winning card is never rendered) — every earlier trick was discarded. On top of that `compilePrompt` never included `lastTrick` at all, and `GroqProvider` posts exactly `[system, user]` per call with no conversation history, so a bot could not even carry over its own previous turn. Its memory of the hand was not limited, it was zero. Nothing failed: the engine still generated legal moves correctly and every hand still scored right, because card history is needed for *quality* of play, never for *correctness* of it — which is exactly why it went unnoticed.
**Fix (resolved):** `GameState.completedTricks` (`CompletedTrick[]` — cards, winner, lead suit) accumulates through the hand and resets on each deal, passed through fog of war unmasked since every card in it was played face up. `compilePrompt` sends it, trimmed by the seat's difficulty level (`BotTier.memoryFraction`: easy 0, medium 0.25, hard 0.6, extreme 1 of the tricks played so far, most recent first). Measured cost ~34 tokens per trick with the compact `"0:AS"` encoding. **The critical detail is that the prompt reports what it withholds** (`completedTricksShown` vs `completedTricksPlayed`, plus a system-prompt warning): partial history presented as complete is worse than none, because a model that thinks it has seen every trick plays confidently into a card that already fell. See `PROJECT_JOURNAL.md` §15.

### Two derived scores were the only surviving copy of the data they summarised
**Problem:** `PlayerState.tricksWon` and `GameState.handPoints` are both totals computed *from* the tricks played, but the tricks themselves were being thrown away — so neither number could be checked against anything, and a drift bug in either would have been silent and permanent.
**Root cause:** the design kept the summaries and discarded the source, which is backwards. `scoring.ts` reads `state.handPoints[key]` and `p.tricksWon` straight out of stored state; nothing ever recomputed them.
**Fix (resolved):** keeping `completedTricks` (above) makes both derivable again, and `playthrough.test.ts` now re-derives them from the history and asserts equality over a full 29 hand. The rule adopted: **store facts, derive views** — a fact is unrecoverable if not written down, a view is computable on demand, and storing views duplicates truth. The corollary caught a would-be bug in the same pass: a per-player "points still in hand" field was considered and rejected, because *a summary of secret data is still secret data* — "West's hand is worth 7 points" narrows six masked cards enormously in a game whose only point cards are J/9/A/T, and `fog-of-war.ts` has no way to know a number computed elsewhere is a fingerprint of the cards it just masked.

### Groq's free-tier rate limits would throttle an AI-heavy game loop
**Problem:** most turns in this game are AI turns, and Groq's free tier rate-limits per API key — a single key becomes the throughput ceiling for the whole server.
**Root cause:** free-tier per-key request/token budgets are relatively low for a game that calls the LLM on nearly every turn.
**Fix (resolved):** `GroqProvider` accepts a pool of keys (`GROQ_API_KEYS`) and round-robins across them; a key that responds 429/401/403/5xx is skipped in favor of the next one for that same call rather than failing the turn. N keys ≈ N× the effective per-minute headroom.

### dotenv can't hold a multi-line value unless quoted
**Problem:** the multi-key `GROQ_API_KEYS` format (one key per line) doesn't survive in a `.env` file unless the value is wrapped in quotes — an easy thing to get wrong when pasting keys in.
**Root cause:** standard `.env` parsing behavior, not specific to this project, but easy to trip over here.
**Fix (resolved):** documented directly in `.env.example`; the parser (`collectGroqKeys()` in `provider-router.ts`) also accepts comma-separated as a fallback and de-duplicates, so pasting the same key twice by mistake doesn't skew the round-robin.

---

## Database

### The target MongoDB database might already contain incompatible `users`/`sessions` collections
**Problem:** if the same Atlas cluster/database is ever shared with another (e.g. Mongoose-based) app, generic collection names like `users`/`sessions` could already exist with a different schema — one that might not even enforce unique emails — and writing into them would corrupt that data while breaking this project's own uniqueness guarantee.
**Root cause:** collection names are global within a database; nothing stops two unrelated apps from colliding on `users`.
**Fix (resolved):** this project's collections are namespaced (`hcg_users`, `hcg_sessions`) in `backend/src/core/auth/mongo-user-repository.ts`, plus a unique index on normalized email so duplicate registration is a database-level guarantee, not a check-then-insert race in application code.

### A failed index build surfaces as a generic Mongo connection error
**Problem:** if pre-existing documents in the target database violate a new unique index (e.g. duplicate emails already present), Mongo fails the index build — but the error at boot looks like a generic connectivity failure if you're not looking closely.
**Root cause:** the failure happens after a successful connection, during collection setup, so it's easy to misdiagnose as a network/Atlas-allowlist problem.
**Fix (resolved):** `server.ts` pattern-matches the error message (`E11000|duplicate key|Index build failed`) and prints a specific pointer ("check for pre-existing collections that conflict") instead of the generic "check your Atlas allowlist" advice, so the two failure modes don't get confused during debugging.

---

## Auth

### `bcrypt` is a common source of native-module build failures on Windows
**Problem:** `bcrypt` (the standard password-hashing choice) is a native addon requiring a working native toolchain to install/build — a frequent source of install failures on Windows, which is this project's dev environment.
**Root cause:** native Node addons need node-gyp + a C++ toolchain configured correctly; this is fragile on Windows specifically.
**Fix (resolved):** used Node's built-in `scrypt` (`node:crypto`, no native dependency) instead — memory-hard, no install risk, cost parameter embedded in the stored hash (`scrypt$N$salt$hash`) so it can be raised later without invalidating existing accounts. See `backend/src/core/auth/password.ts`.

### "UNAUTHENTICATED — Invalid or expired session token" greeted the player *after* a successful sign-in
**Problem:** the error toast appeared on the lobby of a session that was demonstrably working — connection dot green, games listed, the player signed in. Reported as happening "quite often when I sign in again."
**Root cause:** two independent leaks across the session boundary in `frontend/src/useGameConnection.ts`.
1. **A toast outliving its session.** When the server rejects a token it sends `ERROR: UNAUTHENTICATED` and closes with `AUTH_FAILED`. The close set `sessionExpired`, which correctly signed the user out — but the error itself had already been written to `lastError`, and the effect that rebuilds the socket on a token change reset `sessionExpired` without ever clearing `lastError`. `App` only renders the toast on the signed-in branch, so it stayed invisible on the sign-in screen and then surfaced on the *next* session's first render. The token it was complaining about was the dead one, which is why nothing was actually wrong with the new session. In dev this fires constantly: with no `MONGODB_URI` the session store is in-memory, so every `tsx watch` restart invalidates the token sitting in `localStorage`.
2. **A dead socket reconnecting with the dead token.** `disposedRef` was a single ref shared by every run of the effect. React runs the cleanup and the next effect back to back on a token change, but the old socket's `close` event only lands a tick later — by then the ref had already been reset to `false` for the new session, so the abandoned socket read itself as live, reconnected with the *previous* token, overwrote `wsRef`, and got rejected. That both orphaned the real socket and signed the user out seconds after they signed in. StrictMode's double-mount in dev exercises exactly this path.
**Fix (resolved):** the disposed flag is now a `let cancelled` scoped to a single effect run, and every socket callback additionally checks `wsRef.current === ws` before touching shared state or the heartbeat timers — a superseded socket closes itself and stays silent. `lastError`/`games` are cleared both when a session starts and when it ends. `UNAUTHENTICATED` is no longer toasted at all: the sign-out it triggers is the whole story the player needs, and `AuthScreen` now says why ("Your session has expired. Please sign in again.") instead of leaving them to guess. Related: `send()` now queues until `AUTHENTICATED` rather than until the socket is merely `OPEN` — anything sent in that window was answered with the *other* `UNAUTHENTICATED` ("Send AUTHENTICATE before any other message") and shown as the same opaque toast.

---

## Multi-node / clustering

### A card game can't be load-balanced like a normal stateless API
**Problem:** a live match holds dealt hands in memory and drives an AI-turn timer server-side; two instances "serving" the same match independently would each deal a different next hand and both believe they're authoritative. Sticky sessions don't fix this either, since they don't survive a reconnect (a new WS connection can land on a different node).
**Root cause:** the match is genuinely stateful and self-driving, not a request/response resource.
**Fix (resolved):** redesigned around **one owner node per match**, with commands routed to the owner over Redis request/reply and state fanned out over per-match pub/sub (`core/cluster/match-gateway.ts`, `ownership-registry.ts`). Full mechanics in `SCALING.md`.

### A hard-killed node never fires a socket `close` event
**Problem:** in the single-node design, a seat only reverts to AI control when its socket fires `close`. A node that's killed outright (not gracefully shut down) never fires that event for its connections — across a cluster, that would permanently pin a seat away from AI control.
**Root cause:** TCP/process death doesn't guarantee a clean event on the peer side.
**Fix (resolved):** every node re-asserts its live connections to each match's owner on a timer; the owner evicts any connection it hasn't heard reasserted within `presenceTtlMs`. A lost `close` event heals on the next tick instead of stalling the table indefinitely.

### A match everybody left kept playing itself out on fallback moves
**Problem:** when the last player disconnected, the table did not stop — it kept advancing for the full `noHumanTimeoutMs` window (120s), playing `legal_moves[0]` for every seat because nobody was connected to spend LLM quota for. That is long enough to finish hands. A player who refreshed at the wrong moment could come back to a match several tricks — or a whole hand — further on than they left it, played by nobody, with no way to tell what had happened.
**Root cause:** two separate rules composing badly. A seat only blocks the AI runner while its owner has a live connection, so with *nobody* connected no seat blocks it at all and the loop runs free. The no-human timeout was then implemented as a deadline checked *inside* that loop — so the loop had to keep running to notice it, and everything it did while noticing was a move in a real game.
**Fix (resolved):** the loop now returns immediately when `connectedUsers` is empty (`driveAiTurns`), including after the round intermission so it can't deal a hand into an empty room, and the fallback-because-nobody-is-watching branch is gone with it — an AI seat only ever moves while somebody is there to see it. The countdown moved out of the loop into a timer (`LiveMatch.abandonTimer`), armed by `touchPresence` when the table empties and cleared the moment anyone returns, which is what lets the loop stop and still have something left to do the counting. On expiry the match is **terminated**, not merely paused: `MatchGateway.releaseAbandoned` now deletes the durable snapshot as well as releasing the lease, since leaving it behind would let the next command for that matchId `recover()` the table and start it running again.

### Stopping the loop on an empty table exposed two things that had been getting away with never restarting it
**Problem:** two paths only worked because an unattended match kept playing regardless. (1) `MatchManager.connect()` records presence but never resumes the turn loop, so a player reconnecting to a paused match with an AI seat on the clock would have sat there forever — nothing else would ever wake it. (2) Presence was only ever recorded for *seated* players, so the host who starts an all-AI table and watches without sitting down counted as nobody, and their match would freeze the instant it started and be terminated two minutes later with them watching it.
**Root cause:** both are cases where "the loop is always running anyway" silently substituted for a wake-up that was never written. Neither could fail while an empty table played itself out.
**Fix (resolved):** the gateway's JOIN handler snapshots the state for the reply and *then* kicks `manager.resume(matchId)`, so a rejoin restarts the loop without holding up the JOIN. `ENTER_ROOM` now calls `trackPresence` like `JOIN` does, and `handleStart` calls the new `MatchGateway.syncPresenceNow(matchId)` right after START to assert seatless watchers immediately instead of on the next 10s presence tick. A match is empty only when nobody is looking at it at all.

### The Redis-backed classes had never run against a real Redis instance
**Problem:** `RedisEventBus`, `RedisOwnershipRegistry`, `RedisRateLimiter`, `RedisSessionCache` (including their Lua CAS scripts and `ioredis` wiring) had only ever been exercised through in-memory siblings and an in-process shared test backplane that runs identical routing logic — never a live Redis server. Not one line of Lua had executed and not one socket had opened.
**Root cause:** no Redis or Docker available on the machine this was built on.
**Fix (resolved 2026-08-27):** run against a real managed Redis (Redis Cloud). `core/cluster/redis-integration.test.ts` — 21 cases covering the CLAIM/RENEW/RELEASE lease Lua, the token-bucket rate-limit Lua, cross-node pub/sub and request/reply, the session cache, connection counting, and a full two-gateway match round trip — passed **21/21** on the first run, in ~29s. Beyond the suite, two actual server processes were run against one Redis and one Mongo: a session issued by node A authenticated on node B, a match created on A was joined and played through B with state fanning back to both, and node A was then **hard-killed mid-match** (no graceful shutdown, so no lease release and no socket close) — node B waited out the lease, rebuilt the match from its durable snapshot (`[gateway] recovering match "…" from snapshot @ seq 7`) and served it to the reconnecting player. Nothing in the Redis layer needed changing; the design held as written. Set `REDIS_TEST_URL` to re-run the suite (`cd backend && npx vitest run redis-integration`); it is skipped without it, so the default offline run is unaffected.

---

## Plugins

### Every `rules.json` in the repo acquired a UTF-8 BOM, which fail-fasts the server at boot
**Problem:** all nine `rules.json` files (both built-ins and all seven `game-plugins/` entries) started with `EF BB BF`. `JSON.parse` rejects a BOM outright — `Unexpected token '﻿'` — so `PluginManager.loadAll` threw at boot and the backend could not start. `game-library.test.ts` and `tier-b.test.ts` failed at collection for the same reason. A running server survived only because it had loaded the files before the BOMs appeared.
**Root cause:** the files were rewritten at some point by a tool that defaults to BOM-prefixed UTF-8 — on Windows that's Notepad and PowerShell's `Out-File`/`Set-Content` (`Set-Content` needs an explicit `-Encoding utf8`; even then Windows PowerShell 5.1 writes a BOM).
**Fix (resolved):** stripped the BOM from all nine files, and made the parse path tolerate one so it cannot recur — `stripBom()` in `core/plugin/plugin-manager.ts`, applied both in `loadOne` and in `plugin-routes.ts`'s `parseRules`. Editing `rules.json` by hand is a headline feature of this project, and most of the editors a user reaches for on Windows add a BOM silently; "not valid JSON" on a file that looks perfect is a terrible thing to hand them.

### `plugin-import.test.ts`, `game-library.test.ts` and `match-manager.test.ts` asserted the pre-refactor plugin contract
**Problem:** 20 backend tests failed (`plugin-import` 12, `game-library` 7, `match-manager` 1) and `npm run typecheck` reported 24 errors across the same three files — mostly TS2554 "Expected 3 arguments, but got 4" and TS2339 "Property 'gameId' does not exist on type 'RulesDsl'".
**Root cause:** the refactor that removed `gameId` from `rules.json` (ids are server-assigned now; create and edit became different verbs) updated the implementation and the plugin files but not these three suites. They still called `importPlugin(rules, strategy, overwrite, owner)` against a 3-parameter method, and still asserted `rules.gameId === <directory name>` for each library plugin.
**Fix (resolved):** `plugin-import.test.ts` was rewritten around the new contract rather than patched — the old `overwrite=true` cases split into `updatePlugin` (owner edits in place, id survives) and `PluginProtectedError` (built-in refuses), and a new case asserts the behaviour that replaced the conflict: importing the same rules.json twice yields two independent games. `game-library.test.ts`'s "gameId matches its directory name" inverted into "does not declare a gameId", which now guards the invariant instead of the old one. Suite is green at 261/261. See `PROJECT_JOURNAL.md` §13.

### `tsc --noEmit` in a workspace typechecks its dependencies' *stale* `dist/`, hiding real breakage
**Problem:** after removing `gameId` from `RulesDsl` in `shared/`, `npm run typecheck` reported errors only in test files and gave the backend's `src/core/engine/state.ts` a clean bill of health — even though it read `rules.gameId` in four places, one of which set `GameState.gameId`. Fixing only what was reported would have shipped a match-identity bug.
**Root cause:** `backend` imports `@hcg/shared` by its package entry, which resolves to `shared/dist/*.d.ts`, not `shared/src/`. The root `typecheck` script runs `tsc --noEmit` per workspace, and `--noEmit` never regenerates `dist/` — so the backend was checked against the *previous* build's type definitions, in which `RulesDsl.gameId` still existed.
**Fix (resolved):** run `npm run build --workspace @hcg/shared` before typechecking the backend or frontend after any `shared/` type change. This is the same ordering constraint that applies to `npm run build` (shared must build first); it applies to `typecheck` too, which is not obvious from the script name. A clean typecheck of a dependent workspace means nothing until `shared/dist` is current.

### Imported plugins had no owner and lived only on one node's local disk
**Problem:** any signed-in user could see, start matches with, edit, or delete *any* imported plugin — there was no concept of "who imported this." Worse, an imported plugin's `rules.json`/`strategy.md` were written to the booting node's local `backend/src/games/<id>/` directory, which doesn't survive a restart on an ephemeral filesystem and isn't visible to any other node in a multi-node deployment (built-in games are fine on disk — they're shipped, source-controlled server content, not user data).
**Root cause:** `PluginManager` was designed only against the built-in-games case (boot-time disk scan) before runtime import existed, and ownership/durability were never revisited when `POST /api/plugins` was added.
**Fix (resolved):** added `PluginRepository` (`core/plugin/plugin-repository.ts`, `core/plugin/mongo-plugin-repository.ts`) — the same `InMemory*`/`Mongo*` pattern as `MatchRepository`/`UserRepository` — as the durable, shared home for imported plugins, with an `ownerUserId` on each. `PluginManager.getVisible(gameId, userId)` is the single read path enforcing that only the owner (or nobody, for a public/built-in game) ever resolves a private plugin; built-ins are unaffected and stay disk-based. See `PROJECT_JOURNAL.md` §11.

### A plugin's id was authored in its own `rules.json`, so importing a game meant claiming a global name
**Problem:** `rules.json` declared `"gameId"`, and that string was the registry key, the database `_id`, and the URL path segment. Three consequences, all bad: importing a file whose id was taken was a hard 409 rather than just adding a game; the same rules.json could never be imported twice (there was no way to keep an original alongside a variant); and because built-ins lived in the same flat namespace and were editable by any signed-in user, a user could overwrite or `rm` the shipped 29 and Callbreak by importing a file that named them.
**Root cause:** identity and content were the same document. Nothing separated "what this game is" from "which record this is", so authoring content implicitly claimed a name — in a namespace shared with every other user and with the server's own defaults.
**Fix (resolved):** `gameId` is gone from the DSL and *rejected* by `validateRulesDsl` rather than ignored, so an author who writes one is told why instead of silently getting a different id. A built-in is now identified by its folder name (stable across restarts, which is what keeps persisted match records resolving, and works with no Mongo configured); an imported plugin by an id `PluginRepository.create` mints — a real Mongo `ObjectId`, or a `randomUUID` in the in-memory sibling. Built-ins became immutable: `PluginProtectedError` on edit or delete, no disk-write path left in `PluginManager` at all, and customising one is now a fork (`GET` its source → change → `POST` as your own private copy). Import always creates; editing moved to `PUT /api/plugins/:gameId`. See `PROJECT_JOURNAL.md` §13.

### Plugins imported under the old id scheme took down their owner's entire catalog
**Problem:** signing in as an account that had imported plugins before that refactor produced `INTERNAL — Something went wrong handling that message` and a permanently empty game list — not just missing imports, but no built-in games either. Other accounts were unaffected, which made it look account-specific rather than data-specific.
**Root cause:** the same assumption in two layers. `hcg_plugins` still holds documents whose `_id` is the *string* gameId from the old `rules.json` (`mendicot`, `whist`, `325`, `oh-hell`) rather than a minted `ObjectId`. `toStored()` called `doc._id.toHexString()`, which exists only on `ObjectId`, so `findByOwner` threw a `TypeError` for anyone owning such a document. `summaries()` awaited that directly, the rejection escaped through `LIST_GAMES` to the WebSocket's generic error handler, and because the catalog is a single response, one unreadable row cost the player every game in it. `toObjectId()` had a quieter form of the same bug: `findById`/`update`/`delete` returned early on a legacy id, so those plugins could not be opened, edited or deleted either — they behaved as though they did not exist.
**Fix (resolved):** `mongo-plugin-repository.ts` now treats `_id` as `ObjectId | string` — `idToString()` renders either shape, and `idFilter()` matches both at once via `$in`, so a legacy plugin resolves everywhere a minted one does. Separately, `summaries()` builds each entry inside a `try`/`catch` and skips (with a console warning naming the plugin) anything it cannot summarise, so no single row can empty a catalog again. Verified against the live database: the affected account went from 0 games plus an error to 6, and all four legacy ids resolve through `getVisible`. No migration was written and none is needed — the documents are read as they are, which also keeps any persisted match that references one of those ids resolvable.

---

## Frontend / table UI

### ♠ and ♣ were indistinguishable on a card at hand size
**Problem:** spade and club cards read as the same card at a glance. In a fanned hand the only suit marker visible is the corner glyph, and at the size it was drawn (0.58rem ≈ 9px) ♠ and ♣ are both a dark lobed blob over a stem — the shapes only separate at pip/ace size, which is exactly the part of the card that's covered by the next card in the fan.
**Root cause:** the traditional two-colour deck. `Card.tsx` split suits into `card-red`/`card-black`, so both black suits rendered in the identical `--card-ink`, leaving glyph shape as the *only* differentiator at the one size where glyph shape doesn't survive.
**Fix (resolved):** one ink colour per suit (`--suit-spade|heart|diamond|club`, `.card-suit-S|H|D|C`), with clubs in green as on a four-colour deck; the corner glyph also went from 0.58rem to 0.68rem. The green is a clear luminance step lighter than the spade black, not just a different hue, so the two suits still separate for a colour-blind player. Hearts and diamonds stay red — flipping diamonds to blue for the full four-colour deck is a one-line change to `--suit-diamond` if the red pair ever reads the same way. The `Led` chip in the app bar sits on the dark rail rather than on card stock, so it can't use these inks and prints the suit letter beside the glyph instead (matching the `Trump` chip). See `PROJECT_JOURNAL.md` §12.

---

## Production readiness (2026-08-27)

> A theme runs through all five of these: **every one was invisible to the dev loop and fatal outside it.** Nothing here failed a test, a typecheck, or `npm run dev`. They were found by actually running the thing the way it would be deployed — which, until this pass, nobody ever had.

### `npm run build && npm start` had never worked — the compiled server could not find its games
**Problem:** the production start path died at boot with `Cannot read games directory "…\backend\dist\games": ENOENT`. Not a degraded mode, not a slow path — the documented way to run this in production had never once succeeded.
**Root cause:** `tsc` compiles `.ts` and copies nothing else, but a game plugin is a *folder* — `rules.json` plus `strategy.md` — and `PluginManager.loadAll` scans that folder relative to the running module. From `dist/server.js` that means `dist/games/`, which the build never created. It went unnoticed because `npm run dev` runs `tsx src/server.ts`, where the same scan lands on `src/games/` and everything is already there. **The dev loop and the production loop resolved different directories, and only one of them existed.**
**Fix (resolved):** `backend/scripts/copy-games.mjs`, wired into the backend's `build` script after `tsc`. It copies `src/games/` to `dist/games/` and then *fails the build* if the destination is empty, so a future refactor cannot quietly reintroduce a server that boots into an empty catalog. Shipped games belong in the build output — they are source-controlled server content. User-imported plugins are a different thing entirely and live in `PluginRepository`, never on disk (see the Plugins section above).

### A missing Groq key killed the boot, in direct contradiction of two documents that promised it wouldn't
**Problem:** starting with no `GROQ_API_KEYS` threw `GroqProvider requires at least one apiKey` and the process exited.
**Root cause:** `GroqProvider`'s constructor throws when handed no keys, which is correct *for the class* — an instance that cannot possibly work should not exist — and `createBotTiersFromEnv` let it propagate all the way out of `main()`. Two places in the repo state the opposite behaviour: `config/env.ts` classes an absent key as **non-fatal**, with the comment *"the engine's fallback is to play `legal_moves[0]`, so the game still runs"*, and `CLAUDE.md` promises *"Everything works with `.env` mostly empty"*. It didn't run, and it didn't work. The condition never came up on a machine that has a key — which is every machine this was developed on.
**Fix (resolved):** `UnconfiguredProvider` (`core/ai/provider.ts`) — a provider that always rejects with a message naming the missing variable. `createBotTiersFromEnv` substitutes it for either provider when no key is configured, so `decideTurn` takes the deterministic fallback path it already has for a timed-out or broken API. The boot banner reads `AI provider: groq (unconfigured)`. **Deliberately a provider that fails rather than one that silently returns the first legal move:** the second would make a misconfigured server indistinguishable from a working one in the logs, which is the exact failure mode this whole pass exists to remove. Four cases in `provider-router.test.ts` now hold the invariant.

### The production frontend bundle hard-coded `ws://localhost:3001`
**Problem:** `VITE_WS_URL` unset — the normal case for a single-origin deploy — left the built client connecting to `localhost:3001`, i.e. **the player's own machine**. Every deployed user would get a page that loads perfectly and a socket that never connects.
**Root cause:** `api.ts` and `App.tsx` each carried their own copy of `import.meta.env.VITE_WS_URL ?? 'ws://localhost:3001'`. The fallback is right in development (Vite serves on `:5173`, the backend listens on `:3001`, so same-origin is the one thing it cannot be) and unconditionally wrong in a build. Nothing catches it: the build succeeds, the bundle is valid, and the failure happens in a browser the developer never opens.
**Fix (resolved):** one `resolveWsUrl()` in `api.ts`, imported by `App.tsx` — the duplication was itself half the bug. `VITE_WS_URL` still wins when set (split-origin deploys); otherwise `import.meta.env.DEV` keeps the localhost default for dev, and a production build derives the origin from `window.location`, using `wss:` when the page is `https:` so the browser doesn't block it as mixed content. Verified the shipped bundle contains no `localhost` string at all — the dev branch is tree-shaken out — and that a same-origin upgrade is accepted while `Origin: https://evil.example.com` still gets a 403.

### Password reset was fully implemented on the server and had nowhere to land
**Problem:** `AuthService` minted a token, `ResendEmailSender` mailed a link to `${APP_BASE_URL}/reset-password?token=…`, and the frontend had no such route, no component, and no `api.ts` function. Following the link produced the lobby or a blank page depending on how it was served. `change-password`, `sessions` and `logout-all` were in the same state: implemented, routed, tested server-side, reachable only with curl.
**Root cause:** the feature was built from the database outwards and stopped at the HTTP boundary. Every server-side test passed, because every server-side test was accurate — the missing half had nothing to fail.
**Fix (resolved):** `ForgotPassword`, `ResetPassword` and `AccountPanel` components, an `AuthShell` extracted so the three signed-out screens share one set of chrome (a reset page that has drifted into looking like a different site is what makes a password link feel like phishing), and a `/reset-password` check in `App.tsx` that runs **before** the signed-in gate — the whole point of a reset is that you can't sign in. No router dependency; the project has none and needs none. On success the server's own `AuthSuccess` signs the user straight in, and `history.replaceState` clears the spent token from the address bar so a refresh can't retry it. The full lifecycle was then exercised end to end against a live server: identical `{ok:true}` for registered and unknown addresses, exactly one email sent, minimum length enforced, token consumed on first use and rejected on second, **every pre-existing session revoked**, old password dead, new session working.

### `env.test.ts` did not compile, so the whole backend build was broken
**Problem:** `npm run build` and `npm run typecheck` both failed on `TS2339: Property 'RESEND_API_KEY' does not exist on type '{ ALLOW_CONSOLE_EMAIL: string; }'`.
**Root cause:** spreading a `NodeJS.ProcessEnv` into an object literal (`{ ...goodProduction(), ALLOW_CONSOLE_EMAIL: 'true' }`) discards its index signature, so the inferred type held only the one explicit key and `delete env.RESEND_API_KEY` stopped compiling. The file's sibling tests use `const env = goodProduction()` — annotated by the function's return type — and were fine, which is why the pattern looked safe.
**Fix (resolved):** annotate the binding (`const env: NodeJS.ProcessEnv = …`). Worth recording less for the fix than for what it implies: this error was sitting in committed-adjacent work, meaning the production-readiness code that `config/env.ts` represents had itself never been typechecked.

---

## AI game designer (2026-08-28)

### A draft can satisfy every schema rule and still deadlock a match
**Problem:** `validateRulesDsl` was the obvious gate for AI-authored `rules.json`, and it is not sufficient. A document declaring a `CARD_EXCHANGE` phase passes every structural check — the kind is a legal `PhaseKind`, the phase chain is well-formed, nothing is missing — and then hangs the first time a real hand reaches that phase, because `generateLegalMoves` has no implementation for it and returns `[]`. Same class of failure for `microPhases`, which `GameState` has a field for and no interpreter behind.
**Root cause:** the validator answers "is this well-formed", which is the right question for a file a person hand-wrote and can debug. A model fails differently — it produces *plausible* documents, and plausibility and playability are not the same property. The schema is deliberately permissive about phases so the DSL can grow; that permissiveness is exactly the hole.
**Fix (resolved):** `core/authoring/draft-validator.ts` deals and plays every draft before a human sees it — `createMatch` → `generateLegalMoves` → `applyMove` → `applyHandScoring`, at every table size the plugin claims, over two hands, on fixed seeds. The same loop `game-library.test.ts` already holds the shipped catalog to. Failure messages name the phase and seat (`no legal move exists in phase "EXCHANGE" (kind CARD_EXCHANGE) for seat 0`) because they are fed straight back into the repair prompt, where specificity is what makes the fix reliable. `DSL_LIMITATIONS` separately tells the model not to emit either primitive in the first place.

### A hallucinated field is worse than a syntax error
**Problem:** a model shown no schema invents plausible vocabulary — `"trickRules": { "mustBeatHighest": true }`. Unknown keys are **ignored, not rejected**, so the draft validates, plays, and is quietly not the game that was asked for. There is no error anywhere for the author to notice.
**Root cause:** the DSL's tolerance of extra keys is right for forward compatibility and wrong for a generative author.
**Fix (resolved):** `dsl-reference.ts` enumerates the entire DSL — every `TrumpMode`, `PhaseKind`, `ScoringFormula`, `DealConfig`, `ActionTypeName`, `CompoundCondition` — plus an explicit list of what it *cannot* express, with the instruction to simplify faithfully and declare the omission in `notes` rather than invent a field. Verified on the hardest available case: asked for full Hearts, it produced a playable Hearts using every correct primitive (`penalty-points`, `lowerIsBetter`, `moonShot`, `suitPointValues`, `cardPointValues`, `lockedLeadSuits`), emitted no `CARD_EXCHANGE` phase, and reported the two rules it had to drop.

### The DSL reference is a second copy of the schema, and copies rot
**Problem:** adding a primitive to `rules-schema.ts` without updating `dsl-reference.ts` produces a designer that can never generate it. Nothing fails; from outside it just looks like a model that is not very good — the worst kind of regression, because it is indistinguishable from the feature's normal imperfection.
**Root cause:** unavoidable duplication. A TypeScript union is not a prompt, and there is no way to hand a model a type.
**Fix (resolved):** `dsl-reference.test.ts` reads `shared/src/rules-schema.ts` **as text**, extracts the members of each union with a regex, and asserts every one appears in `DSL_REFERENCE`. The schema stays the single source of truth and the drift becomes a test failure. It also `JSON.parse`s the worked example and runs `validateRulesDsl` on it — a malformed example is worse than none, being the most closely copied part of the prompt.

### Groq charges `max_tokens` before generating anything, so a generous ceiling is a 413
**Problem:** the first live drafting call failed instantly: `Request too large for model openai/gpt-oss-120b ... on tokens per minute (TPM): Limit 8000, Requested 20190`. The prompt was ~4000 tokens and `DESIGNER_MAX_TOKENS` was 16000.
**Root cause:** Groq reserves the whole `max_tokens` ceiling against the per-minute budget **at request time**, whether or not the reply uses it. A ceiling is not free, which inverts the usual "err high, it is only a cap" instinct. Relayed raw, the error reads as *"your prompt is too big"* — sending the operator to shorten the prompt, the one change that cannot fix it.
**Fix (resolved):** default lowered to 8000, `DESIGNER_MAX_TOKENS` made configurable, and `describeGroqFailure` rewrites this specific 413 to name the actual levers (the ceiling, the model, the tier). `config/env.ts` warns below 2000, where the first draft of a session truncates mid-JSON every time. `.env` on this machine is set to **3200**, which fits an 8000 TPM free key.

### `groq/compound` advertises 70000 TPM and does not have it
**Problem:** with every plain chat model on the account capped at 8000 TPM, `groq/compound` looked like the way out — `/models` reports a 70000 token limit for it. Switching to it produced a 413 "Request Entity Too Large" after ~90s of key rotation.
**Root cause:** `groq/compound` proxies to `openai/gpt-oss-120b`, and its calls are charged against **that model's** 8000 budget. Confirmed directly by probing it with progressively larger prompts: at ~4500 words it returns a 429 whose message names `openai/gpt-oss-120b`, not compound. The advertised limit belongs to the wrapper, not to the inference it performs.
**Fix (resolved):** abandoned as an escape hatch and documented in `GAME_DESIGNER.md` §7 so nobody spends the same afternoon on it. The real fix was fitting inside 8000 (below).

### Every path on a free tier is one shared 8000-token window, so the prompt had to earn its size
**Problem:** even at a sane ceiling, refine turns did not fit. Prompt (~3700-token DSL reference + ~1200-token prior `rules.json` + ~1400-token prior `strategy.md`) plus any usable reply budget exceeded 8000.
**Root cause:** the first implementation sent the full context every turn — the whole reference, the worked example, the strategy brief, and both halves of the prior draft — on the reasonable-sounding grounds that more context is safer.
**Fix (resolved):** two changes, both of which turned out to be better prompting rather than mere economy.
1. **The worked example is dropped on a refine.** The model is holding a valid document it wrote itself; Callbreak is a worse and less relevant example than its own draft.
2. **`strategy.md` is carried forward, not round-tripped.** It is neither sent in the prompt nor requested in the reply unless the author's instruction is actually about the guide (`briefConcernsStrategy`); the server substitutes the existing one. Saves ~1400 tokens in each direction **and closes a real failure mode** — a rules tweak can no longer quietly rewrite a strategy guide the author was happy with, and every avoided regeneration is an avoided chance to degrade it.
A refine that previously 413'd now completes in 5.5s, valid and playable, guide intact. Worth recording as the general lesson: the token constraint pointed at a correctness improvement, not just a cheaper prompt.

### The default drafting model did not exist on the account
**Problem:** the first end-to-end run failed with `The model llama-3.3-70b-versatile does not exist or you do not have access to it` — a model chosen for being a widely-available, strong JSON-following default.
**Root cause:** guessing at model availability. Groq's catalog differs per account and per tier; "generally available" is not a property you can assume from outside.
**Fix (resolved):** default changed to `openai/gpt-oss-120b` — the reasoning-capable Groq model this codebase **already names** in `GroqProviderOptions` and `.env.example`, which makes it the one safe assumption about what a key for this project can reach. Confirmed present by listing `/v1/models`. Note the failure mode was already correct: a clean 502 with the provider's own message, not a broken boot, because the designer resolves its model lazily at call time rather than validating it at startup.

### A TPM refusal is retryable across keys; the retry classifier said otherwise
**Problem:** `isWorthRetryingOnAnotherKey` returned false for every 413, on the sound general reasoning that a too-large request fails identically everywhere.
**Root cause:** true for a body-size 413, false for a rate-limit 413. The TPM budget belongs to the Groq **organization** that owns the key, and this deployment's 11-key pool spans about that many separate accounts — visible in the errors, which quote different `org_...` ids. One drafting call genuinely succeeded on one key and was refused on another.
**Fix (resolved):** 413 with a TPM message added to the retryable set. It cannot rescue a single request that exceeds *any* org's limit — that still needs a smaller ceiling — but it makes the pool do what a pool is for.

### `parseDecisionResponse` was too narrow for authoring replies
**Problem:** the existing parser strips one markdown fence and calls `JSON.parse`. That is enough for a 40-token move decision and fails on a 3000-token authored document, which arrives with a chatty preamble, a fence, a trailing offer to help, or all three.
**Root cause:** a helper sized for the shape of a different response.
**Fix (resolved):** `extractJsonObject` scans for the outermost balanced `{...}` while tracking string literals and escapes — so a brace inside the strategy prose cannot end the scan early, which the naive "first `{` to last `}`" approach gets wrong. An unbalanced scan is reported as *"the reply was probably cut off by the token limit"* rather than "invalid JSON", because the latter sends the reader hunting for a syntax error that does not exist. `parseDecisionResponse` was left untouched: the hot path did not need changing and is not worth the risk.

### A model told not to emit a `gameId` sometimes emits one anyway
**Problem:** `validateRulesDsl` rejects a `gameId` outright, so one stray key burns a whole repair attempt (and a whole TPM window).
**Root cause:** the rejection exists to teach a *human* author that identity is the server's to assign — a good error for a person reading it, pure cost for a model that will not remember the lesson.
**Fix (resolved):** `parseDesignResponse` strips a top-level `gameId` before validating. The rejection stays exactly as it is for the hand-authored and file-upload paths, where the lesson is the point.

### Bash heredocs mangled TypeScript containing template literals
**Problem:** several `cat > file.ts <<'EOF'` writes failed with `unexpected EOF while looking for matching '`, and one Python patch script silently failed its own assertion after the file content had round-tripped through the shell.
**Root cause:** shell quoting interacting badly with backticks and `${...}` in TypeScript template literals, despite the quoted-delimiter form that is supposed to prevent exactly that.
**Fix (resolved):** wrote the larger source files with the editor tooling directly and reserved the shell for short, mechanical patches. Recorded because the failure was noisy in one direction (a shell parse error) and silent in the other (an assertion that failed *after* the content looked correct on inspection) — the silent one cost the most time.

---

## Housekeeping / open items

### "Leave match" is client-side only, so leaving is not the same as disconnecting
**Problem:** the Leave button (`App.tsx` → `conn.leaveMatch()`) clears the client's own `matchId`/`room`/`state` and nothing else. There is no `LEAVE` message in the wire protocol, so the server keeps that socket's `conn.matchId` set, keeps fanning state out to it, and keeps counting it as presence on the match.
**Root cause:** leaving was built as a view transition rather than a protocol event — which was invisible while the only thing presence controlled was whether one seat fell to the AI.
**Status: OPEN.** It matters now that presence decides whether a match is terminated (`PROJECT_JOURNAL.md` §17): a table everyone *left* is not a table everyone *disconnected from*, so the countdown never starts and the match holds a lease until the last of those tabs is actually closed. The fix is a `LEAVE` client message that unwatches, clears `conn.matchId`, and reports the disconnect — the same three things `teardown` already does on socket close. Note also that the client's `STATE_UPDATE` handler writes `resumeRef` unconditionally, so a fan-out arriving after a leave stores `{ matchId: null }`; that wants cleaning up in the same pass.

### Plaintext credentials were present in `.env` early in the project
**Problem:** the Groq API key and MongoDB Atlas password were in plaintext in `.env` at project start (a normal local-dev necessity, but a real exposure if that state ever leaked — e.g. accidental commit, screen share).
**Status: OPEN, action required.** Rotate every credential that has been held in plaintext or pasted anywhere outside the `.env` file: the **Groq API key**, the **MongoDB Atlas password**, the **Redis Cloud password** and the **Resend API key**. The last two were supplied over a chat transcript on 2026-08-27, which is another durable copy — a credential is exposed once it has been anywhere other than the secret store, regardless of whether anything bad has happened yet. Rotation points: Groq <https://console.groq.com/keys>, Atlas → Database Access, Redis Cloud → database → Security, Resend <https://resend.com/api-keys>. Also confirm `.env` was never committed (`.gitignore` covers it, but verify no earlier commit predates that).

### Draft `325/` plugin folder ended up at the repo root instead of the plugin scan path
**Problem:** a `rules.json` + `strategy.md` draft for the 3-2-5 game sits at `Hybrid_ Card_Game/325/`, but the actual plugin scan root is `backend/src/games/`. The app never loads it, despite looking like a present, working plugin at a glance.
**Root cause:** authoring mistake — created adjacent to the repo instead of inside `backend/src/games/325/`.
**Fix (resolved):** moved to `game-plugins/325/`, which is the browsable library rather than the boot scan path — so it no longer implies working 3-2-5 support while staying available to anyone who wants to finish it. It still needs the micro-phase/card-pulling interpreter that was never built (`PROJECT_JOURNAL.md` §6.1), and `TODO.md` is where that primitive is tracked.
