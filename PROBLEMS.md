# Problems & Solutions Log

> Concrete obstacles hit while building this project, why they happened, and how they were resolved (or why they're still open). This is the "what went wrong and what we did about it" companion to `PROJECT_JOURNAL.md` (which covers "what we chose and why" more broadly). Add a new entry here any time something breaks, surprises you, or requires a workaround — don't let the fix live only in a code comment or a chat transcript.

Format per entry: **Problem** → **Root cause** → **Fix / current status**.

---

## Security & WebSocket transport

### Cross-site WebSocket hijacking
**Problem:** the browser's same-origin policy — which protects `fetch`/XHR — does **not** apply to WebSocket connections. Any page on the internet can open `ws://your-server` from inside a victim's browser.
**Root cause:** WS is exempt from same-origin policy by spec; relying on it for socket security was never going to work.
**Fix (resolved):** `Origin` header is checked against an allowlist at the HTTP *upgrade*, before any socket state is allocated (`backend/src/ws/origin.ts`). As a second layer, the session token lives in `localStorage`, not a cookie — a hijacked cross-site socket has nothing to authenticate with even if origin checking were somehow bypassed. Non-browser clients (no `Origin` header at all — CLI tools, load tests) are allowed through, since the whole threat model is "victim's browser rides on the victim's session," which doesn't apply to them.

### Browsers can't send native WebSocket ping frames
**Problem:** `readyState` on a browser WebSocket can stay `OPEN` long after the underlying connection is actually dead (wifi drop, proxy silently closed an idle tunnel), and browsers have no API to send an RFC 6455 ping frame to proactively check.
**Root cause:** platform limitation, not something server-side heartbeat logic alone can detect from the client's side.
**Fix (resolved):** added an application-level `PING`/`PONG` message pair in the wire protocol (`shared/src/protocol.ts`), sent by the client every 20s, on top of the server's real RFC 6455 ping/pong. A missed round on either side terminates the connection and frees the seat.

### Thundering herd on reconnect after a server restart
**Problem:** a plain exponential backoff reconnect strategy brings every disconnected client back online at (roughly) the same moment after a restart, which can immediately re-topple a server that just came back up.
**Root cause:** exponential backoff alone is deterministic across clients that all disconnected at the same instant.
**Fix (resolved):** added **full jitter** to the reconnect backoff in `frontend/src/useGameConnection.ts` — the randomization matters more than the backoff curve itself here.

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

### The Redis-backed classes have never run against a real Redis instance
**Problem:** `RedisEventBus`, `RedisOwnershipRegistry`, `RedisRateLimiter`, `RedisSessionCache` (including their Lua CAS scripts and `ioredis` wiring) have only ever been exercised through in-memory siblings and an in-process shared test backplane that runs identical routing logic — never a live Redis server.
**Root cause:** no Redis or Docker available on the machine this was built on.
**Status: OPEN.** Do not trust a multi-node production deploy until the cluster has been run against a real Redis at least once. Flagged in both `SCALING.md` and `PROJECT_JOURNAL.md`.

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

## Housekeeping / open items

### Plaintext credentials were present in `.env` early in the project
**Problem:** the Groq API key and MongoDB Atlas password were in plaintext in `.env` at project start (a normal local-dev necessity, but a real exposure if that state ever leaked — e.g. accidental commit, screen share).
**Status: OPEN, action required.** Rotate the Groq API key and the MongoDB Atlas password. Confirm `.env` was never committed (`.gitignore` covers it, but verify no earlier commit predates that).

### Draft `325/` plugin folder ended up at the repo root instead of the plugin scan path
**Problem:** a `rules.json` + `strategy.md` draft for the 3-2-5 game sits at `Hybrid_ Card_Game/325/`, but the actual plugin scan root is `backend/src/games/`. The app never loads it, despite looking like a present, working plugin at a glance.
**Root cause:** authoring mistake — created adjacent to the repo instead of inside `backend/src/games/325/`.
**Status: OPEN.** Either finish it (it also needs the micro-phase/card-pulling interpreter, which was never built — see `PROJECT_JOURNAL.md` §6.1) and move it into place, or delete it so it stops implying 3-2-5 support that doesn't exist.
