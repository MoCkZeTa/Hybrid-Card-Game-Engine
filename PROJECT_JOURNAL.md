# Project Journal — Universal Hybrid AI Card Game Engine

> **Purpose of this file:** a single, detailed record of what this project is, how it evolved, every major technical decision and the alternatives weighed against it, the full tech stack, current status, and what's left. Written so you (the owner) can re-read it cold in six months and reconstruct the reasoning without re-deriving it. This is a living document — update it as the project changes, don't let it go stale like a changelog nobody reads.
>
> Last verified against the actual repo on **2026-07-30**. Where this doc states a fact about the code (test counts, file names, dependency versions), it was checked directly, not recalled — but code moves faster than docs, so if something looks off, trust the code and fix this file.

---

## 1. What this project is

A **Universal Hybrid AI Card Game Engine**: a Node.js/TypeScript backend that runs multi-phase trick-taking card games (29, Callbreak, with 3-2-5/Spades/Hearts as future targets) as **plugins**, paired with an LLM that plays the AI seats. The founding constraint, taken directly from the PRD (`PRD.md`, root of repo):

- **Adding a new card game requires zero engine code changes.** A game is just a folder with two files: `rules.json` (a DSL describing deck, phases, trump rules, trick-taking constraints, scoring) and `strategy.md` (a natural-language strategy guide fed to the LLM's system prompt).
- **Zero hallucinations.** The TypeScript engine is the sole source of truth for what moves are legal at any point (`legal_moves`). The LLM never invents a move — it picks one identifier from a bounded, engine-generated list. If it picks anything else, or doesn't answer in time, the engine plays `legal_moves[0]` for it. The AI is a *strategist choosing among engine-approved options*, never a rules referee.
- **Compound and multi-step actions** are supported without breaking the "single choice from a list" contract. A `CompoundActionRule` can fuse a sequence into one atomic legal-move (the original design), or — via `atomic: false` — offer only its first action standalone and let the engine's normal per-turn generation supply the rest as a separate decision once state has moved on. 29 uses the split form for "reveal hidden trump, then play a card": revealing is its own optional choice (a player who can follow suit or simply chooses not to reveal just plays normally), and once revealed, `trickRules.mustTrumpAfterOwnReveal` forces that same seat's follow-up play to trump if it holds one.

This PRD was handed off as an implementation spec with explicit "developer's discretion" clauses on architecture (orchestration style, exact schemas, TypeScript types) — meaning the shape of the actual system (below) is our design against that spec, not dictated by it.

---

## 2. History / how we got here

Chronological narrative, reconstructed from the build sessions and repo state.

**Phase 0 — Spec.** `PRD.md` was written first and treated as the fixed requirements document. It fixes the *what* (plugin contract, zero-hallucination principle, latency SLAs, fog-of-war requirement) and explicitly leaves the *how* open (exact DSL shape, orchestration pattern, provider choice).

**Phase 1 — Repo shape and core engine.** First decision was monorepo vs. multi-repo (see §5). Chose one repo with npm workspaces: `shared/`, `backend/`, `frontend/`. Built the DSL engine, legal-move generator, fog-of-war masking, and the two reference plugins (29 and Callbreak — deliberately opposite poles of the DSL: 29 has hidden-trump-reveal compound actions and bidding; Callbreak has fixed trump and no bidding-into-trump).

**Phase 2 — AI pipeline.** Built the `LLMProvider` interface, implemented `GroqProvider` fully, stubbed `GeminiProvider`. Added the strict SLA/fallback loop (`decide.ts`) matching PRD §6 exactly: 1200ms LLM budget, 1500ms total turn budget, `legal_moves[0]` on any failure.

**Phase 3 — Persistence and auth.** Originally the project had **no authentication** — anyone could join any room. Auth was added later: email/password accounts, scrypt password hashing, opaque session tokens stored in MongoDB. Persistence was scoped to save **live, in-progress** match state (not just completed-match history) via a fire-and-forget async writer, because that snapshot doubles as the multi-node failover recovery mechanism (see Phase 4).

**Phase 4 — Realtime scaling layer (the largest single addition).** Added an entire optional clustering layer so the backend can run as more than one process behind a load balancer: match-ownership leases over Redis, per-match pub/sub fan-out, cross-node presence tracking, a hardened WebSocket transport (heartbeats, origin allowlisting, frame caps, rate limiting), and full reconnect-with-resume on the frontend. Full design rationale lives in `SCALING.md` (root) — this journal summarizes the *decisions*, that file explains the *mechanics* in more depth.

**Phase 5 — Runtime plugin import.** Added the ability to add/edit/delete a game plugin **from the browser, at runtime**, without touching the server filesystem by hand or restarting: `POST/GET/DELETE /api/plugins` (`backend/src/http/plugin-routes.ts`) backed by `PluginManager.importPlugin()`, with an `ImportPlugin.tsx` UI. A submitted `rules.json` goes through the exact same DSL validation a boot-time plugin does — "the UI is the only confirmation gate," not a weaker validation path. This turned the plugin system from "drop a folder in before you deploy" into a genuine live extensibility feature, which is a step beyond what the PRD asked for.

**Phase 6 — Visual polish v1 and verification.** First visual pass: "classic-luxury" table design (mahogany/brass/cream palette, serif display type, layered felt table, real per-rank card pip layouts). Full end-to-end verification pass: 146/146 backend tests, full workspace typecheck/build, and a manual 17-check scripted run against a live server (two real players, room→start→play, reconnect-resumes-seat, seat-steal refusal, rate limiting, origin rejection, bad-token close code).

**Phase 7 (current) — UI rework: "Ink & Felt".** The classic-luxury look from Phase 6 was replaced, not iterated on — the play screens (room + table) now use a flat dark/light design system called **"Ink & Felt"** (flat tokens, hard offset shadows), a deliberate departure from the mahogany/brass/cream palette. Alongside the visual change, the play screens became a **locked-viewport layout**: `.app-play` is `height: 100dvh` and only the felt area flexes, so the hand, bid control, and scoreboard stay reachable without scrolling; below 860px width that lock releases and the page scrolls normally like any responsive page. Verified with Playwright screenshots across 420–1440px widths, confirming zero page overflow at every width tested.

---

## 3. Tech stack — what, and why over the alternatives

### 3.1 Language & runtime: **Node.js ≥ 20.11, TypeScript 5.6**

One language across `shared`/`backend`/`frontend` means the wire-protocol types (`shared/src/protocol.ts`, `game-state.ts`, `moves.ts`, `rules-schema.ts`) are written once and imported by both client and server — no schema drift, no duplicate type definitions, no codegen step.

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Node + TypeScript** (chosen) | One language for full stack; shared types package with zero duplication; huge ecosystem for both WS and LLM SDKs; PRD explicitly specifies this | Single-threaded (mitigated — see clustering) | **Chosen** |
| Python backend + TS frontend | Great AI/ML ecosystem | Two languages, duplicated types/schemas across the wire, PRD explicitly asked for Node/TS | Rejected |
| Go backend | Better raw concurrency | No shared-types benefit with a TS frontend; smaller LLM SDK ecosystem; team velocity would drop rewriting the DSL evaluator | Rejected |

### 3.2 Monorepo tool: **npm workspaces**

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **npm workspaces** (chosen) | Zero extra tooling — ships with npm; simple `workspace:*`-style deps; good enough for a 3-package repo | No task caching/graph orchestration (not needed at this size) | **Chosen** |
| Turborepo / Nx | Build caching, task graphs, remote cache | Overkill for 3 packages; extra config surface and learning curve for no real payoff yet | Rejected (revisit if the plugin/game count or contributor count grows a lot) |
| pnpm workspaces | Faster installs, strict dependency isolation | Would mean introducing a second package manager convention; no concrete problem it solves here | Rejected |
| **Two separate repos** (engine-only vs. full stack) | Cleaner OSS boundary if the engine were ever published standalone | User explicitly wanted one repo for this project; splitting adds cross-repo versioning overhead for no current benefit | Rejected — **user's explicit call**, see §7 decision log |

### 3.3 Backend transport: **raw `ws` + Node's built-in `http`**, hand-rolled router

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **`ws` + `node:http`** (chosen) | Minimal dependency surface; full control over the upgrade handshake (needed for origin allowlisting before any socket state is allocated — see SCALING.md's CSWSH defense); no framework abstraction fighting the custom match-ownership routing | More boilerplate (manual route matching in `auth-routes.ts`/`plugin-routes.ts`) | **Chosen** |
| Socket.IO | Built-in reconnection, rooms, fallback transports | Its own wire protocol (not plain WS — harder to reason about at the frame level); its "rooms" concept doesn't map to the ownership/lease model we needed for multi-node; reconnection logic we needed (idempotent re-JOIN, full jitter) is custom either way | Rejected |
| Express / Fastify (HTTP layer only, WS still separate) | Cleaner route definitions | Two small route handlers (`/api/auth/*`, `/api/plugins/*`) don't justify a framework dependency; would still need to bolt `ws` on top for the game socket | Rejected — revisit only if the HTTP surface grows much larger |

### 3.4 Frontend: **React 18.3 + Vite 5**

(Note: an earlier memory note said "React 19" — the actual `frontend/package.json` pins `react@^18.3.1`/`react-dom@^18.3.1`. This doc reflects the real pinned version; correct that assumption anywhere else you see it.)

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **React + Vite** (chosen) | Fast dev server/HMR; no framework-level SSR complexity for what is fundamentally a single-page realtime game client; huge component ecosystem if needed later | None significant for this use case | **Chosen** |
| Next.js | SSR/routing/API routes built in | This app has no SEO/SSR need — it's a WS-driven game client behind auth; API routes would duplicate the Node backend that already exists | Rejected |
| Vue / Svelte | Smaller bundles, simpler reactivity model | No concrete advantage here; React was the **user's explicit choice** during setup | Rejected — user's call |
| Vanilla JS / no framework | Zero framework overhead | Component reuse (Card, GameTable, BidPicker, ResultModal, Lobby, Room, AuthScreen, ImportPlugin) would get unwieldy fast for a UI this stateful | Rejected |

### 3.5 Database: **MongoDB Atlas**

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **MongoDB** (chosen) | Schemaless documents fit a game-state blob (varies per plugin/DSL) far better than a fixed relational schema; Atlas gives managed hosting with zero ops; official Node driver is mature | Not ideal for heavily relational data (not a concern here — there's almost none) | **Chosen** |
| PostgreSQL | Strong relational guarantees, JSONB for flexible fields | Would need JSONB columns for game state anyway, effectively re-deriving Mongo's document model with more schema ceremony; no relational data (users↔matches is the only relation, and it's trivial) | Rejected |
| SQLite (embedded) | Zero external dependency, dead simple locally | No good story for a real multi-node deployment (file-based, no concurrent-writer story); the whole point of Phase 4 was multi-node capability | Rejected |
| Redis as the only store | Already in the stack for coordination | Not durable enough by default for account data / match history; would need RDB/AOF tuning to trust it as a system of record — Mongo already solves this | Rejected — Redis is coordination, Mongo is durability; kept separate on purpose |

**Key sub-decision:** persistence saves the **live, in-progress** match state after every move (not just completed matches). This was deliberate — it's also exactly what a node recovers from after a crash/failover (see §3.7), so "save for history" and "save for recovery" are the same write path instead of two.

### 3.6 AI providers: **Groq (primary, implemented) + Gemini (stub only)**, behind an `LLMProvider` interface

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Groq** (chosen, implemented) | Extremely fast inference (LPU hardware) — critical because the PRD's total turn SLA is 1500ms including the network round trip; generous free tier; OpenAI-compatible-ish request shape | Smaller model catalog than OpenAI/Anthropic; free-tier per-key rate limits (mitigated — see key-pool note below) | **Chosen as primary** |
| Gemini Flash | Also fast, Google-hosted | Implemented as an interface stub only (`gemini-provider.ts`) — not fleshed out; kept as the designed-in second option per PRD's "Groq / Gemini Flash" directive | **Stub — deliberately not built out** |
| OpenAI (GPT-4o-mini / similar) | Best general reasoning quality | Materially higher latency than Groq for this SLA; PRD explicitly named Groq/Gemini as the target providers | Rejected for now |
| Anthropic (Claude) | High quality reasoning | Not optimized for the sub-second latency budget this game loop needs; PRD scoped the provider choice to Groq/Gemini | Rejected for now — a relaxed-SLA "hard difficulty" mode shipped instead by varying `reasoning_effort` on the existing Groq provider (see below), not by adding a third provider |
| Local model (Ollama/llama.cpp) | No API cost, no network latency | Needs GPU hardware to hit the same tokens/sec Groq gives for free; deployment complexity for a hobbyist target audience | Rejected |

**Provider architecture:** `createProviderFromEnv()` (`backend/src/core/ai/provider-router.ts`) reads `LLM_PROVIDER` and builds the right `LLMProvider`. This is intentionally a **single small function**, not a plugin system of its own — "the entire router" is one switch statement, because there are exactly two providers and no reason to over-engineer this the way the *game* plugin system is over-engineered on purpose.

**Groq key-pool detail worth remembering:** `GROQ_API_KEYS` accepts multiple keys (newline- or comma-separated); requests round-robin across them, and a rate-limited/revoked key is skipped in favor of the next. This exists because Groq's free tier is per-key rate-limited — N keys ≈ N× the per-minute headroom, which matters a lot for an AI-heavy game loop where most turns are AI turns.

**Fallback discipline (`decide.ts`):** every call is wrapped in an `AbortController` on a timer; a timeout, thrown error, or an LLM response with a `moveId` outside the legal set all degrade identically to playing `legal_moves[0]`, tagged `source: 'fallback'` for the decision log. If there's only one legal move, the LLM isn't called at all — saves latency and API cost on forced moves.

**Bot difficulty levels (`BotLevel`, `shared/src/protocol.ts`):** the host picks one of four levels — Easy / Medium / Hard / Extremely Hard — when starting a match that has at least one empty seat; the level applies to every AI seat in that match (not per-seat — considered and rejected as unneeded complexity for a feature aimed at "how hard is this table," not per-opponent tuning). Deliberately reuses existing machinery instead of adding a second provider or a set of hand-picked models per level:

- **Same model across all four levels; only Groq's `reasoning_effort` varies** (easy omits it, medium/hard/extreme send low/medium/high) — reuses `GroqProviderOptions.reasoningEffort` and `maxTokensFor()`'s existing 500/1400/2200/3500 token-budget table exactly as they were, just exposed as named levels instead of one env-wide setting.
- **LLM timeout is a fixed ladder per level** (1500/4000/6300/10000ms), *not* derived from `LLM_TIMEOUT_MS` — a harder level's hidden chain-of-thought needs proportionally more wall-clock budget or it just times out into the existing `legal_moves[0]` fallback before ever finishing. `LLM_TIMEOUT_MS` still exists but no longer governs AI-seat turns.
- **`createBotTiersFromEnv()`** (`provider-router.ts`) builds all four `LLMProvider` instances once at boot, alongside `createProviderFromEnv()` (kept, currently unused, as a reusable single-provider building block). Gemini has no `reasoning_effort` knob, so its four tiers share one provider instance — quality separation by level is Groq-only for now; a plain (non-reasoning-capable) `GROQ_MODEL` has the same limitation, since Groq rejects `reasoning_effort` outside 400 for those models and the turn falls back to `legal_moves[0]` — a real operational caveat of not swapping models per level, accepted because per-level model selection was explicitly out of scope. This isn't hypothetical: `.env` shipped with `GROQ_MODEL=llama-3.1-8b-instant` (a plain chat model), which broke exactly this way in practice — Medium/Hard/Extremely Hard all fell back to `legal_moves[0]` on every turn with no startup-time signal, and only Easy played normally. Root-caused and fixed by driving the real `createBotTiersFromEnv`/`GroqProvider` code path against the live Groq API (not mocks) for all four levels; `GROQ_MODEL=openai/gpt-oss-120b` is confirmed working end-to-end for all four. See `PROBLEMS.md` → "`GROQ_MODEL` set to a plain chat model silently broke Medium/Hard/Extremely Hard bots".
- **Default level tracks `GROQ_REASONING_EFFORT`** (unset→Easy, low→Medium, medium→Hard, high→Extreme) so a host who never opens the picker — or an old client that omits `botLevel` — gets exactly the behavior the server was already configured for before this feature existed.
- Not persisted through node failover/adoption (`MatchManager.adopt()`), same treatment as seat claims and the RNG stream — falls back to the configured default level, documented in that method's own comment rather than extending the persistence schema for it.

### 3.7 Multi-node scaling: **Redis, entirely optional**

This is the single biggest architectural decision in the project, and it's covered in depth in `SCALING.md`. Summary of the *decision*, not the mechanics:

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Optional Redis, dual in-memory/Redis implementation behind one interface** (chosen) | Same code path in dev and prod — no "works locally, breaks in prod" drift; zero setup cost for local dev (no Docker/Redis required); scales to N nodes when needed | Two implementations of each interface (`LocalEventBus`/`RedisEventBus`, `LocalOwnershipRegistry`/`RedisOwnershipRegistry`, etc.) to maintain in parallel | **Chosen** |
| Always require Redis, even for 1 node | Simpler — one code path, period | Forces every local dev session to run Docker/Redis just to start the server; the user has neither installed | Rejected |
| Sticky sessions at the load balancer (no ownership layer at all) | No Redis needed | Doesn't survive a reconnect (a new WS connection can land on a different node); doesn't solve "which node's memory is authoritative" for AI-turn timers running server-side | Rejected — fundamentally doesn't fit a stateful, self-driving match |
| Stateless backend, game state fully in Redis/DB per-move | True horizontal scaling, no per-node ownership needed | Every single move (including AI turns firing on a timer) becomes a round trip to external storage instead of an in-memory operation — kills the 1500ms turn SLA | Rejected |

**Why a card game specifically can't be load-balanced like a normal stateless API:** a live match holds dealt hands in memory and runs an AI turn loop on a timer. Two instances both "serving" it would each deal a different next hand and both believe they're right. The chosen model is **one owner node per match; commands route to the owner over Redis request/reply; state fan-out happens over per-match pub/sub**. Ownership is a renewable TTL lease (Lua CAS script), not a permanent assignment, so a dead node's matches free themselves automatically.

**Deliberately not recovered on failover** (both by design, not oversight): seat claims (every seat reverts to AI-controlled until its human reconnects — losing a couple of AI turns beats risking handing a hand to the wrong reconnecting client) and the RNG stream (reseeded — only future, unseen deals differ).

### 3.8 Auth: **custom email/password, scrypt hashing, opaque session tokens in Mongo (Redis-cached)**

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Custom email/password + opaque tokens** (chosen) | No third-party dependency/cost; full control; simple mental model | Reinventing a (small) wheel; no social login | **Chosen** |
| OAuth (Google/GitHub login) | No password storage at all; familiar UX | Extra setup (OAuth app registration, redirect URIs); overkill for a hobby project's current audience | Rejected — could add later as an additional path, not a replacement |
| JWT (stateless, self-contained tokens) | No Mongo read on every request/handshake; scales trivially across nodes with zero shared state | Revocation is hard (can't kill a single session without a blocklist, which reintroduces the shared-state problem JWTs are meant to avoid); this project already added a `SessionCache` (Redis-backed) that gets JWT's main benefit (fewer Mongo reads) without losing instant revocation | Rejected — noted explicitly in `SCALING.md` as "a JWT change, not a Redis one" if ever revisited |
| Auth-as-a-service (Auth0, Clerk, Supabase Auth) | Batteries included, less code to maintain | External cost and dependency for a project that's otherwise self-hosted end to end; not needed at this scale | Rejected |

**Password hashing: Node's built-in `scrypt`, not `bcrypt`.** Explicit tradeoff, documented in the code comment (`backend/src/core/auth/password.ts`): bcrypt is a native addon and a common source of build pain on Windows (which is this project's dev environment). `scrypt` is memory-hard, built into `node:crypto`, and the cost parameter (`N=16384`, ~100ms/hash) is embedded in the stored hash string (`scrypt$N$salt$hash`) so it can be raised later without invalidating existing accounts.

**Login error messages are intentionally identical** for "unknown email" and "wrong password" — prevents using the login endpoint to enumerate registered emails.

### 3.9 Testing: **Vitest**

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Vitest** (chosen) | Native ESM/TS support with no Babel config; fast (esbuild-based); Vite-family consistency with the frontend tooling | Slightly younger ecosystem than Jest | **Chosen** |
| Jest | Most mature/ubiquitous | Needs extra config for ESM + TS (`ts-jest` or Babel) that Vitest gets for free given the project is already `"type": "module"` end to end | Rejected |

---

## 4. Architecture deep dive

### 4.1 Plugin / DSL system

- `rules.json` per game (`backend/src/games/<id>/rules.json`) declares: metadata & player topology, deck (suits/ranks/point weights), phase lifecycle (`DEALING → BIDDING → TRUMP_SELECTION → PLAYING → SCORING`, per game), trump mechanics (static/bid-selected/hidden-reveal), trick-taking constraints (must-follow-suit, must-trump-if-void, etc.), and scoring/quota rules.
- `strategy.md` per game is natural-language guidance compiled directly into the LLM system prompt (`core/ai/prompt.ts` compiles plugin + masked state + legal choices into the final prompt).
- `PluginManager` (`core/plugin/plugin-manager.ts`) scans `backend/src/games/` at boot (`PluginManager.loadAll(gamesRoot)`, called from `server.ts`), validates each `rules.json` against `shared/src/rules-schema.ts`, and fails fast on an invalid DSL per PRD §6.
- Two reference plugins ship today: **29** and **Callbreak** — picked as opposite poles of the DSL (29: hidden-trump reveal, compound actions, bidding into a contract; Callbreak: fixed trump, no bidding-into-trump, different quota/scoring shape) specifically to stress-test that the DSL generalizes rather than being shaped around one game.
- **Runtime plugin import** (Phase 5): `POST /api/plugins` (`backend/src/http/plugin-routes.ts`) lets an authenticated user submit a new `rules.json` (as JSON or pasted raw text) + `strategy.md` from the browser (`ImportPlugin.tsx`), validated through the *identical* path a boot-time plugin goes through, then written to `backend/src/games/<id>/` so it survives a restart and is registered immediately — no server restart, no manual file drop needed. The same endpoint (`overwrite: true`) edits existing plugins, including the built-in 29/Callbreak, and `DELETE` removes any plugin from disk. The UI's confirmation dialog is the only safety gate on this — there's no additional server-side "is this a built-in game" protection, which is a deliberate simplicity choice worth remembering if this ever needs to be locked down for a public-facing deployment.

### 4.2 Legal-move engine & fog of war

- `core/engine/legal-moves.ts` evaluates the current `GameState` against the active `RulesDsl` to produce the bounded `legal_moves` array the AI (and the human UI) choose from.
- `core/obfuscation/fog-of-war.ts` masks a `GameState` per-seat before it's ever serialized to a prompt or a client: opponents' hidden cards, unrevealed trump, etc. become `"STATUS: HIDDEN"`. This runs **both** before every AI prompt and before every WebSocket state push — the same function, so there's no risk of the AI-facing mask and the client-facing mask silently diverging.
- Compound actions (PRD §4.2 Requirement A) are declared per-game in `rules.json`'s `compoundActions`. Default (`atomic` omitted or `true`): fused into a single combined `legal_moves` entry, executed as one indivisible choice. `atomic: false`: only the sequence's first action becomes its own standalone move; the remaining action(s) fall out of the engine's normal per-turn generation on the *next* call, since firing a non-`PLAY_CARD` action never advances `turnSeat` — the same seat is simply asked again with the new state visible. 29's `reveal-and-play` rule uses the split form (`backend/src/games/29/rules.json`): revealing trump is offered as its own optional move alongside normal plays (a player can choose to keep playing without revealing), and `GameState.pendingTrumpReveal` (set on `REVEAL_TRUMP`, cleared on the next `PLAY_CARD`) plus `trickRules.mustTrumpAfterOwnReveal: true` force that seat's follow-up card to be a trump if it holds one — mirrored generically in `legal-moves.ts`'s `followSuitOptions`/`forceMustTrump`, not hardcoded to the `"29"` gameId, so any future hidden-trump plugin can opt into the same split-then-force behavior purely through `rules.json`.
  - `CompoundActionRule.condition` (singular) became `conditions` (array, AND-combined) so a rule can compose requirements instead of the schema needing a new named `CompoundCondition` kind for every combination a game happens to need — 29 doesn't currently combine more than one, but the schema no longer blocks a future rule that does. Any player void in the led suit may still trigger the reveal (unchanged eligibility — a declarer-only restriction was tried and reverted; the product intent here is "whoever is void may choose to expose trump," not "only the declarer may"). What did change: move labels for both the split and atomic reveal forms now read `"Reveal trump"` / `"Reveal trump and play <card>"` with no suit name, where they previously printed the real suit (e.g. `"Reveal trump (Spades)"`) directly in the option text before the player had chosen to reveal it — a leak that bypassed `fog-of-war.ts`'s masking (which correctly withholds `trumpSuit` from non-declarers; the leak was the label text, not the state field). The suit is now discovered *by* choosing to reveal, never before.
- Micro-phase sequential actions (PRD §4.2 Requirement B, e.g. 3-2-5's draw-then-return card exchange) are supported by the DSL's phase model in principle but **the interpreter for this specific pattern was not built** — see §6, Out of Scope.
- `MaskedGameState` carries three more generic, DSL-driven fields so the client can render a game correctly without knowing its rules: `scoringBasis` (mirrors `rules.scoring.contractBasis`), `handPoints` (live per-team card points captured *this hand*, mirroring `teamScores`'s shape but reset every hand — always present, zeros for a tricks-scored game), and each `MaskedPlayerState.teamKey` (that seat's `teamScores`/`handPoints` key, or `null` in a `solo` game). None of this is hidden information — every point value is visible the moment its trick is won — so exposing it is just surfacing state that already existed (`GameState.handPoints`) rather than deriving anything new. `GameTable.tsx` uses `scoringBasis === 'points'` to swap a seat's individual trick count for its *team's* shared live point total (both partners' tiles read the same number) and to show a live "+N this hand" next to the scoreboard's running total — driven entirely by the DSL flag, not a `gameId === '29'` check, so any future points-scored game gets the same treatment for free.

### 4.3 AI decision pipeline

`decideTurn()` (`core/ai/decide.ts`) is the single place that owns the game-loop clock:
1. Mask state for the seat, get `legal_moves`.
2. Zero legal moves → engine error (shouldn't happen if the DSL is well-formed). One legal move → skip the LLM entirely, play it as `source: 'forced'`.
3. Otherwise, compile the prompt, call the provider under an `AbortController` timing out at `LLM_TIMEOUT_MS` (default 1200ms).
4. Any of {timeout, thrown error, `moveId` not in the legal set} → play `legal_moves[0]`, tagged `source: 'fallback'` with a human-readable reason logged for later inspection.
5. Otherwise → play the LLM's choice, tagged `source: 'llm'`, with latency and reasoning recorded.

Every decision is logged via `decision-logger.ts` (toggle: `LOG_AI=false` to silence; `LOG_AI_VERBOSE=true` for full reasoning text) — useful for judging AI play quality without re-reading game transcripts by hand.

### 4.4 Realtime / multi-node layer

See `SCALING.md` for the full write-up; the shape:

- `core/cluster/ownership-registry.ts` — TTL lease per match, Lua compare-and-swap for claim/renew/release. `LocalOwnershipRegistry` (single process, a plain Map) and `RedisOwnershipRegistry` (multi-node) implement the same interface.
- `core/cluster/match-gateway.ts` — routes an incoming command to the owning node (or claims the match locally if unowned), recovers an orphaned match from its Mongo snapshot, publishes masked per-seat + spectator views on every state change.
- `core/cluster/event-bus.ts` — the pub/sub abstraction (`LocalEventBus`/`RedisEventBus`) match-gateway rides on.
- Cross-node presence: nodes re-assert live connections to each match's owner on a timer; the owner evicts connections it hasn't heard from within `presenceTtlMs`, so a hard-killed node (no `close` event ever fires) can't permanently block a seat from reverting to AI control.
- `ws/ws-server.ts` — the hardened transport: RFC 6455 ping/pong heartbeat, origin allowlist enforced at the HTTP upgrade (before any socket state is allocated — defends against cross-site WebSocket hijacking, which same-origin policy does not cover), 16 KiB frame cap, 10s unauthenticated-handshake window, backpressure disconnect past 1 MiB buffered, per-connection/per-user/global connection caps, token-bucket rate limiting.
- Close codes centralized in `shared/src/protocol.ts` (`WS_CLOSE`); the client (`useGameConnection.ts`) treats `AUTH_FAILED` as terminal (signs out) and reconnects on everything else.
- Frontend reconnection: exponential backoff **with full jitter** (a plain exponential backoff would bring every client back at the exact same instant after a server restart and re-topple it), idempotent re-JOIN/ENTER_ROOM on reconnect so a resumed session lands back at the table rather than the lobby, plus reconnect triggers on `online`/`focus`/`visibilitychange` (a laptop waking from sleep almost always has a dead socket, and checking immediately beats waiting out the next heartbeat).
- Graceful shutdown (`lifecycle/shutdown.ts`) drains in a fixed order: stop advertising `/ready` → close sockets with `GOING_AWAY` → release match ownership → close Redis → close Mongo. Bounded, so a hung step can't hang the whole shutdown.

### 4.5 Persistence

- `core/persistence/persist-writer.ts` (`AsyncPersistenceWriter`) writes the live match snapshot after every move, off the critical path (fire-and-forget, sequence-numbered so out-of-order writes can be detected/discarded).
- `MongoMatchRepository` / `InMemoryMatchRepository` behind a `MatchRepository` interface — same dual-implementation pattern as the cluster layer, so tests and no-Mongo local runs use the in-memory sibling with identical calling code.
- This snapshot is *also* the multi-node failover recovery source — one write path serves both "match history" and "disaster recovery," deliberately, rather than building two.

---

## 5. Full repository map

```
Hybrid_ Card_Game/
├── PRD.md                     # The original spec — architecture left to implementer's discretion in places
├── SCALING.md                 # Deep-dive on the realtime/clustering layer (mechanics; this file is decisions)
├── PROJECT_JOURNAL.md          # This file
├── PROBLEMS.md                 # Concrete obstacles hit + root cause + fix/status — companion to this file
├── .env / .env.example         # Runtime config — see §8 for the full variable reference
├── package.json                 # Root workspace manifest — npm workspaces: shared, backend, frontend
├── TODO.md                     # Tier C games + the engine primitives each is blocked on — see §10
├── game-plugins/               # Plugin LIBRARY — validated rules.json+strategy.md pairs, deliberately
│   │                           # NOT on the scan path; copy in or import via POST /api/plugins (§10)
│   ├── README.md               # Install/edit instructions + per-plugin caveats
│   ├── 325/                    # 3-2-5 — was the stray root folder, now a valid plugin (§6.3)
│   ├── mendicot/  court-piece/  whist/
│   └── hearts/    spades/       oh-hell/
│
├── shared/                     # @hcg/shared — wire protocol + DSL types, zero runtime deps
│   └── src/
│       ├── index.ts
│       ├── protocol.ts         # WS message shapes, WS_CLOSE codes
│       ├── game-state.ts       # GameState, SeatIndex, etc.
│       ├── moves.ts            # Decision, move/legal-move types
│       ├── cards.ts            # Card/suit/rank primitives
│       ├── auth.ts             # AuthUser etc.
│       └── rules-schema.ts     # RulesDsl type + validator for rules.json
│
├── backend/                    # @hcg/backend — Node/TS engine + WS server
│   └── src/
│       ├── server.ts            # Entry point — boots plugins, provider, Mongo, Redis, auth, HTTP+WS
│       ├── core/
│       │   ├── engine/          # deck, state, trick, scoring, legal-moves, apply-move
│       │   ├── plugin/          # PluginManager — load/import/delete, DSL validation
│       │   ├── obfuscation/     # fog-of-war.ts — per-seat state masking
│       │   ├── ai/              # provider.ts, groq-provider.ts, gemini-provider.ts,
│       │   │                    # provider-router.ts, prompt.ts, decide.ts, decision-logger.ts
│       │   ├── auth/            # auth-service.ts, password.ts (scrypt), user-repository (Mongo/in-memory),
│       │   │                    # session-cache.ts (Redis/in-memory)
│       │   ├── match/           # match-manager.ts — drives a single match's turn loop
│       │   ├── cluster/         # ownership-registry, event-bus, match-gateway — multi-node routing
│       │   ├── persistence/     # match-repository (Mongo/in-memory), persist-writer.ts
│       │   ├── ratelimit/       # rate-limiter.ts (Redis/in-memory token bucket)
│       │   ├── redis/           # redis-client.ts — connection bundle builder
│       │   └── errors.ts
│       ├── games/               # THE actual plugin scan root (gamesRoot in server.ts)
│       │   ├── 29/{rules.json, strategy.md}
│       │   └── callbreak/{rules.json, strategy.md}
│       ├── http/                # auth-routes.ts, plugin-routes.ts, cors.ts
│       ├── ws/                  # ws-server.ts (transport), origin.ts (allowlist parsing)
│       └── lifecycle/           # shutdown.ts
│
└── frontend/                    # @hcg/frontend — React 18 + Vite + TS
    └── src/
        ├── main.tsx / App.tsx    # Entry, connection banner, top-level routing between screens
        ├── api.ts                # REST calls (auth, plugin import)
        ├── useGameConnection.ts  # WS client — reconnect/backoff/jitter/resume, heartbeat
        └── components/
            ├── AuthScreen.tsx
            ├── Lobby.tsx
            ├── Room.tsx
            ├── GameTable.tsx
            ├── Card.tsx
            ├── BidPicker.tsx
            ├── ResultModal.tsx
            └── ImportPlugin.tsx  # Runtime plugin upload/edit UI
```

---

## 6. Known gaps, out-of-scope items, and stray files

### 6.1 Deliberately out of scope (per PRD or explicit later decision)
- **Micro-phase interpreter** for the general "draw-then-return" pattern (PRD §4.2 Requirement B) — the DSL has a phase model that *could* support this, but the actual interpreter logic for 3-2-5's card-pulling mechanic was never built out. 3-2-5's `rules.json` (in the stray `325/` folder, see below) documents the mechanic in the DSL shape, but nothing executes it.
- **`GeminiProvider` body** — the interface implementation exists (`gemini-provider.ts`) but is a stub, not wired to a real API call. `LLM_PROVIDER=gemini` would need this finished before it's usable.
- **Real-time speed games** (Slapjack) and **priority-stack games** (Magic: The Gathering) — explicitly out of scope per PRD §7, since the whole engine model assumes a synchronous turn-by-turn structure.

### 6.2 Known untested path
- **The Redis-backed classes (`RedisEventBus`, `RedisOwnershipRegistry`, `RedisRateLimiter`, `RedisSessionCache`) have never run against a real Redis instance** — there's no Redis or Docker available on the dev machine this was built on. Their *logic* is exercised through the in-memory siblings and an in-process shared backplane that drives identical routing code (`core/cluster/match-gateway.test.ts` in particular), but the actual Lua scripts and `ioredis` wiring are unexercised. **Run a real multi-node test against a live Redis before trusting a multi-node production deploy** — this is flagged in `SCALING.md` too, worth repeating here.

### 6.3 ~~Stray file: root-level `325/` folder~~ — resolved 2026-07-31
The draft 3-2-5 plugin that sat loose at the repo root is now `game-plugins/325/`, rewritten into a DSL that actually validates (see §11). Its original draft used invented fields — `deal.mode: "batched"`, `trump.mode: "chooser-selection"`, a top-level `quotas` block — none of which the schema had, so it would have been rejected on load had anything tried to load it. The real mechanics it described are now expressible: `deck.excludedCards` for the 30-card deck, `trump.mode: "chooser"` for the dealer's-right trump pick, `scoring.fixedQuotasByDealerOffset` for the 2/3/5 quotas, and the pre-existing `biddingHandSize` for the staged deal. Its card-pulling exchange still needs the micro-phase interpreter (§6.1) and is tracked in `TODO.md`.

---

## 7. Key decision log (quick reference table)

| Decision | Chosen | Alternatives considered | Who decided |
|---|---|---|---|
| Repo layout | One repo, npm workspaces (`shared`/`backend`/`frontend`) | Two-repo split, engine-only repo | **User's explicit request** |
| Frontend framework | React 18 + Vite | Vue, Svelte, Next.js, vanilla JS | **User's explicit request** during setup |
| Persistence scope | Live in-progress state, not just completed matches | Completed-matches-only history | **User's explicit request**; doubles as failover recovery source |
| LLM provider scope | Groq fully implemented; Gemini as interface stub only | Building both out fully; OpenAI/Anthropic as primary | **User's explicit request** to scope down |
| Auth | Added later: email/password, scrypt, opaque tokens | Staying unauthenticated (the original state); OAuth; JWT | Progressive — project started with none, auth added as a deliberate hardening pass |
| Redis | Fully optional, dual in-memory/Redis implementation | Mandatory Redis; sticky sessions; fully stateless-per-move backend | Architectural call, driven by "must run with zero setup locally" |
| Password hashing | `node:crypto` scrypt | bcrypt | Avoids native-module build pain on Windows dev machine |
| Reference plugins | 29 + Callbreak | Any other pair | Chosen specifically as DSL-stressing opposite poles |
| Scoring extensibility | Named formula table (`ScoringFormula`) with constants | An expression AST in JSON; one hardcoded curve per `contractBasis` (the old behavior) | Every real game's payout is one of ~6 shapes with different numbers — naming the shapes keeps a rules.json editor picking from a bounded list instead of writing arithmetic that would need its own evaluator |
| Non-trick-taking games (Poker, Teen Patti, Rummy) | Out of `RulesDsl` entirely — a separate plugin family if ever built | Generalising `RulesDsl` to cover both families | They have no tricks, trump or follow-suit rule, so the whole trick-taking half of the schema is dead weight to them; forcing them in makes the DSL worse at what it currently does well |

---

## 8. Environment variable reference

(From `.env.example` — copy to `.env`, never commit `.env`.)

| Variable | Purpose | Default / notes |
|---|---|---|
| `MONGODB_URI` | Atlas connection string | Required in production; falls back to in-memory locally with a warning |
| `LLM_PROVIDER` | `groq` \| `gemini` | Default `groq` |
| `GROQ_API_KEYS` / `GROQ_API_KEY` | Key pool for round-robin (newline/comma separated) | Multiple keys ≈ multiplied per-minute free-tier headroom |
| `GROQ_MODEL` | Model name | Default `llama-3.1-8b-instant` in code; `.env.example` suggests `llama-3.3-70b-versatile` |
| `GROQ_REASONING_EFFORT` | `low`\|`medium`\|`high`, reasoning-capable models only | Optional; also sets which `BotLevel` the host's difficulty picker defaults to (§3.6) |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | Only used if `LLM_PROVIDER=gemini` | Provider body is a stub — see §6.1 |
| `REDIS_URL` | Enables multi-node clustering | Empty = single-node in-memory. **Hard startup failure if set + unreachable in production** |
| `REDIS_KEY_PREFIX` | Namespacing for shared Redis | Default `hcg` |
| `REDIS_COMMAND_TIMEOUT_MS` | Redis command timeout | Default 3000 |
| `NODE_ID` | Stable node identity in logs | Default: random UUID per boot |
| `MATCH_LEASE_TTL_MS` | Ownership lease lifetime | Default 30000 — shorter = faster failover, more Redis traffic |
| `PORT` | HTTP+WS port | Default 3001 |
| `NODE_ENV` | `development` \| `production` | Production tightens several fallback behaviors to hard failures |
| `CORS_ORIGIN` | Allowlisted origin(s), comma-separated | Enforced on both CORS and the WS upgrade |
| `TRUST_PROXY` | Trust `X-Forwarded-For` | Only set `true` behind a proxy you control — otherwise spoofable, defeats per-IP rate limiting |
| `WS_HEARTBEAT_MS` | Server ping interval | Default 30000 |
| `WS_MAX_CONNECTIONS` | Hard cap on concurrent sockets per instance | Default 10000 |
| `LLM_TIMEOUT_MS` | Per-turn LLM call budget | Default 1200 (PRD §6) |
| `TURN_TIMEOUT_MS` | Total turn SLA | Default 1500 (PRD §6) |
| `LOG_AI` | Set `false` to silence AI decision logging | Default on |
| `LOG_AI_VERBOSE` | Set `true` for full reasoning text in logs | Default off (truncated) |

---

## 9. Current status snapshot (as of 2026-07-31)

- **Tests:** 244/244 passing (21 test files), full workspace typecheck and build clean. (Was 149 before the Tier B pass in §10 added `game-library.test.ts` and `tier-b.test.ts`; §11 added 6 more covering imported-plugin ownership.)
- **Manually verified end-to-end** against a live running server: two real players, room creation → start → play, reconnect-resumes-seat, seat-steal refusal, rate limiting, origin rejection, and the `AUTH_FAILED` close code on a bad token.
- **Visual design is currently "Ink & Felt"** (Phase 7) — flat dark/light tokens, hard offset shadows, locked-viewport play screen. This superseded the earlier "classic-luxury" mahogany/brass/cream look from Phase 6; if you see the two described inconsistently anywhere outside this journal, this is the current one.
- **Outstanding action items (carried over, still open unless you've done them):**
  1. Rotate the Groq API key and MongoDB Atlas password that were present in plaintext in `.env` early in the project.
  2. Confirm your current IP is still Atlas-allowlisted under Network Access (this drifts if you change networks).
  3. Before any real multi-node deploy, run the cluster against an actual Redis instance at least once (§6.2) — everything today is verified only through the in-memory/local-backplane equivalents.
  4. ~~Decide the fate of the stray root-level `325/` folder~~ — done 2026-07-31, see §6.3.
  5. The seven `game-plugins/` games are engine-verified (they validate, deal, play to completion and score correctly under test) but **none has been played by a human through the UI**. Install one and play it before treating it as shipped.

---

## 10. Tier B expansion — widening the DSL past 29/Callbreak (2026-07-31)

### Why this happened
The DSL had been proven against exactly two games chosen as opposite poles. That validated the *shape* of the plugin contract but left an open question: how much of the trick-taking family does it actually reach? Sorting the family by mechanic gave three tiers — games that already fit (Tier A), games needing a small targeted schema addition (Tier B), and games needing real rework (Tier C). This pass implemented Tier B and shipped plugins for A and B.

The constraint throughout: **every addition had to be a DSL primitive plus generic engine support, never a game-specific branch.** A user editing `rules.json` is a headline feature, so a game the engine special-cases is a game the user can't modify.

### What was added to the schema

| Primitive | Why it was unavoidable | Used by |
|---|---|---|
| `trump.mode: "none"` | The mode union was closed; a trumpless game had no way to say so | Hearts, Whist |
| `trump.mode: "declared-by-lead"` | Trump fixed by the opening lead rather than by an auction | Court Piece |
| `trump.mode: "chooser"` + `chooserDealerOffset` | Trump named by a seat fixed by *position*, not by bidding. Offset from the dealer rather than an absolute seat, because the dealer rotates | 3-2-5, Mendicot |
| `trump.mode: "kitty-turnup"` | Trump from the first undealt card | Oh Hell |
| `deck.excludedCards` | 3-2-5's 30-card deck is non-rectangular (the Seven exists in only two suits) — inexpressible as suits × ranks | 3-2-5 |
| `deck.suitPointValues` / `deck.cardPointValues` | `pointValues` was rank-keyed only. Hearts scores every Heart at 1 (suit-keyed) and Q♠ at 13 (card-keyed) | Hearts |
| `deck.deal.mode: "schedule"` | Hand size changing hand-to-hand within one match; forced `resolveDeal`/`deal` to take a `handNumber` | Oh Hell |
| `trickRules.lockedLeadSuits` | "Hearts must be broken before they can be led" | Hearts, Spades |
| `bidding.forbidExactTotal` | The hook rule. Implemented by *withholding* the option rather than rejecting it afterwards, preserving the bounded-choice guarantee | Oh Hell |
| `scoring.formula` (6 named curves) | See the decision-log row — replaced two hardcoded per-basis curves | all |
| `scoring.bags` / `nil` / `moonShot` / `lowerIsBetter` | Spades' accumulating overtrick debt, nil contracts, Hearts' moon shot and lowest-wins ordering | Spades, Hearts |
| `scoring.fixedQuotasByDealerOffset` | Contracts assigned by seat position with no bidding at all | 3-2-5 |

Two of these needed new `GameState` fields: `bags` (the only scoring quantity that survives a hand without being folded into `teamScores`) and `brokenSuits` (per-hand, engine bookkeeping only — the constraint it produces is already visible to players via `legalMoves`, following the `pendingTrumpReveal` precedent).

**Fixed quotas are stamped onto `PlayerState.bid` at deal time.** This was the key simplification — it means scoring, the result table and the AI prompt all treat a positional quota as an ordinary bid and need no idea it came from somewhere else.

### Backwards compatibility
`scoring.formula` is optional and defaults per `contractBasis` to exactly the old behavior (`bid-plus-overtrick-fraction` for tricks, `declarer-contract` for points). All 149 pre-existing tests passed unchanged throughout — that was the check that 29 and Callbreak had not been quietly re-scored.

### `game-plugins/` — a library, not a load path
Seven plugins now live at the repo root in `game-plugins/`. **They are deliberately not loaded automatically.** `gamesRoot` in `server.ts` remains `backend/src/games/`; the library is a catalog you install from, either by copying a folder in or via the runtime `POST /api/plugins` path.

The alternative — pointing the loader at both directories — was rejected because plugin loading is fail-fast by design: one invalid `rules.json` in a browsable, user-editable catalog would refuse to boot the whole server. Keeping the catalog outside the load path means editing a library plugin can't brick startup.

29 and Callbreak are *not* duplicated into the library; two copies of a shipped game's rules would drift.

### What the plugins knowingly simplify
Documented in `game-plugins/README.md` and tracked in `TODO.md`: Hearts has no card-passing phase, 3-2-5 no card-pulling exchange (both need the micro-phase interpreter), Mendicot uses the fixed-trump variant, Court Piece scores trick margin rather than session-level hands/courts.

**Euchre was reclassified from Tier A to Tier C.** The initial sort missed that the *left bower* — the off-suit Jack that becomes a trump card and stops being a member of its printed suit — is not expressible by any rank ordering, since it changes what following suit means. A bower-less Euchre would be a plugin claiming to be Euchre that isn't, so it was pulled rather than shipped.

### Scoring corrections (same day, after review)

Two shipped games were being scored wrongly, both caught by the user reading the plugin files rather than by any test — worth noting, because the whole suite passed while both were wrong. The tests asserted the engine did what the plugin *said*; nothing checked the plugin said what the game *is*.

- **29 was paying ±the bid** (so ±16 to ±28 a hand) against a `targetScore` of 60. It is actually one game point either way, however high the contract, and only the declaring side moves — a side that never wins an auction never changes its score. Fixed by parameterising `declarer-contract` with `stake` and `defenders`, and retargeting to 6 points.
- **3-2-5 was scoring "keep your tricks or lose your quota".** It is the *signed difference* from the quota: owe 3 and take 6, score +3; take 2, score −1. This needed a new `bid-difference` formula — no existing curve produces a negative that is only the shortfall.

Auditing the rest turned up two more that were approximations rather than errors: Mendicot and Court Piece both score a **binary hand win** (3 of 4 Tens; 7 of 13 tricks) rather than a margin. Two games needing the same shape justified a `threshold-win` formula. Callbreak, Spades, Hearts, Oh Hell and Whist were checked and were already correct.

The general lesson: a formula table makes it *easy* to give a game the wrong curve, because every curve is valid DSL. Validation catches malformed rules, not wrong ones. Any new plugin needs its scoring checked against the real game by a person.

### Host-configurable match length

`scoring.maxHands` is a plugin property, but match length is the rule players most want to vary per sitting ("best of 3 tonight"), and routing that through a `rules.json` edit would mean editing the game itself to shorten one game of it. So the room host now picks it at room creation.

`GameState.maxHandsOverride` carries the choice (null = use the plugin's), `handLimit(rules, override)` resolves it, and `handLimitBounds(rules)` feeds both the lobby control and the server-side validation — the same function on both sides, so the UI cannot offer a value the server rejects. It is fixed at room creation rather than at start, because the round counter is part of what a joining player sees before they sit down.

### Testing approach
Two new files. `game-library.test.ts` walks every folder in `game-plugins/` and asserts it validates, deals evenly at every supported table size and hand number, and plays a full match to a `GAME` result — so a broken catalog entry fails CI rather than surfacing at import time. `tier-b.test.ts` drives the real plugins to assert each mechanic specifically (moon shot inverts, bags charge 100 at ten, an overtaken exact bid reads `MISSED`, a Heart lead is withheld until broken, quotas follow the rotating dealer).

---

## 11. Private, DB-backed imported plugins (2026-07-31)

### Why this happened
`PluginManager` had always treated every plugin — built-in or runtime-imported — as one flat, unauthenticated, global catalog: `GET /api/plugins` and WS `LIST_GAMES` returned everything to everyone, and any signed-in user could overwrite or delete anyone else's import. The user wanted an imported plugin to belong to its importer: visible, editable, and usable to start new matches only by them, while a friend who receives the match code can still join and play that specific match without ever needing visibility into the plugin itself.

Two things made the straightforward version of this wrong, both raised by the user before implementation:
1. Imported plugins were written to local disk under `gamesRoot` (`backend/src/games/<id>/`) alongside the shipped games. That's fine for built-ins (source-controlled, read once at boot) but wrong for user data — it doesn't survive a restart on an ephemeral filesystem and isn't shared across nodes in a multi-node deployment (a pre-existing gap this surfaced, not one this change introduces for built-ins).
2. A first draft cached visibility checks by eagerly "warming" each user's plugins into memory at login/`AUTHENTICATE`, with a separate synchronous in-memory-only path for WebSocket callers and an async DB-fallback path for HTTP callers. That's two code paths, a staleness window, and a fragile assumption that the node handling `AUTHENTICATE` is the same one that later handles `CREATE_MATCH`. It was simplified to mirror `AuthService.validateToken`'s existing shape exactly instead: one method, always cache-then-repository, no eager warming.

### What changed
- **New `PluginRepository`** (`core/plugin/plugin-repository.ts`, `core/plugin/mongo-plugin-repository.ts`) — the same `InMemory*`/`Mongo*`-behind-one-interface pattern as `MatchRepository`/`UserRepository`, storing `{ gameId, rules, strategy, ownerUserId, updatedAt }`. Built-in games never touch it; they stay disk-based, read once at boot, exactly as before.
- **`GamePlugin.ownerUserId?: string`** — absent means public (a built-in, or a legacy/test-only import with no owner); present means private to that user.
- **`PluginManager.getVisible(gameId, userId)`** is now the single read path for any user-driven, gameId-by-string lookup (creating a room, viewing/editing/deleting a plugin's source): check the in-memory cache, fall back to the repository on a miss, cache the result. A denied caller — wrong owner or truly nonexistent gameId — gets the identical "Unknown gameId" error either way, and unlike the old `get()` (still used internally by `adopt()`/boot, which don't need the DB fallback), it never lists the full registry, so it can't leak the existence of other users' private games.
- **`importPlugin`/`deletePlugin` now take `requestingUserId`.** Editing/deleting an existing built-in stays disk-based and open to any signed-in user. Creating a new plugin, or editing a previously-imported one, is owner-only and DB-backed — no disk write at all.
- **`summaries(userId)` is now async**: built-ins from memory, plus (when `userId` is given) that user's own imports pulled from the repository and cached as a side effect. Confirmed cheap because `LIST_GAMES` fires once per connection and on a manual refresh button — never polled (`frontend/src/useGameConnection.ts`).
- **`MatchManager.createRoom` is now async**, resolving the plugin through `getVisible(gameId, hostUserId)` instead of the old unrestricted `get(gameId)`. Room *joining* (`claimRoomSeat`, `getRoomState`, WS `ENTER_ROOM`/`JOIN`) needed no changes at all — a "match code" is just the room's `matchId`, and joining resolves the room directly rather than looking up a plugin by gameId. This is what lets a friend join and play via a shared match code with zero visibility into the plugin.
- `server.ts` now builds a `PluginRepository` (Mongo-backed when `MONGODB_URI` is set, in-memory otherwise) alongside `matchRepository`/`userRepository` in the existing storage-selection block, and constructs `PluginManager` after that block instead of before it.

### What this deliberately does not do
No eager cache-warming, no new auth-time hooks, no cross-node plugin sync beyond what `getVisible`'s cache-then-repository fallback already provides on a miss. Gameplay itself (`legal-moves`, `decideTurn`, every `applyMove`) never goes through `PluginManager` — a live match holds its own plugin reference in `MatchManager`'s `LiveMatch.plugin` — so none of this puts a database call anywhere near a turn.

### Testing
`core/plugin/plugin-import.test.ts` gained a new `describe('PluginManager ownership and visibility', ...)` block: cross-user catalog/`getVisible` hiding (with an explicit assertion that the denial message never contains a registry dump), built-ins staying open to everyone including anonymous requests, non-owner overwrite/delete rejection, and a plugin resolving purely from a shared `PluginRepository` on a second `PluginManager` instance that never imported it locally (the cross-node case). `core/match/match-manager.test.ts` gained an end-to-end case: a non-owner's `CREATE_MATCH` on a private plugin is rejected, its owner's succeeds, and a second user who only received the `matchId` can still join and sit down.

---

## 12. One ink colour per suit (2026-07-31)

### Why this happened
Spade and club cards looked the same in play. The cause is structural, not a styling slip: on a fanned hand the corner glyph is the *only* suit marker not covered by the next card, and at the size it was drawn (0.58rem, ~9px) ♠ and ♣ are both a dark lobed mass over a stem. The pip field and ace glyph — where the shapes genuinely differ — are the parts the fan hides. With the traditional two-colour deck both black suits shared one `--card-ink`, so shape was carrying the whole distinction at precisely the size where shape stops working.

### What changed
`Card.tsx` no longer classifies suits as red/black; it emits `card-suit-<S|H|D|C>`, backed by four `--suit-*` tokens. Clubs are green (`#14683f`), as on a four-colour deck. The corner glyph also went from 0.58rem to 0.68rem (0.66 → 0.78 on `card-lg`), and the court-card suit from 0.6 to 0.7rem.

Two things drove the specific green. It is a clear **luminance** step lighter than the spade black, not merely a different hue, so the suits still separate under any form of colour blindness — hue alone would have fixed the problem only for players who can see the hue. And it holds ~5.9:1 against the cream stock, so it stays a solid ink rather than a tint. Card stock is cream in both light and dark theme, so unlike most tokens in `styles.css` these need no `prefers-color-scheme` variant.

Hearts and diamonds were deliberately left red. The same argument would justify blue diamonds, but that wasn't the reported problem and it changes the look of every red card; `--suit-diamond` is a one-line flip if it ever comes up.

The `Trump`/`Led` chips in the app bar are the one place suit glyphs appear off card stock — on the dark rail, where the card inks would be unreadable. `Trump` already printed the letter beside the glyph; `Led` now does too, which resolves ♠/♣ there without needing a second, background-specific palette.

### What this deliberately does not do
The suits are still font glyphs, not SVG paths. Hand-drawn paths would give crisper shapes and remove the cross-platform font dependency, but at 9px an SVG spade is the same blob as a glyph spade — the size is the constraint, not the renderer, so it would have been effort spent without fixing the reported problem. The `AuthScreen` hero suits and the decorative `♠` marks (card back, table surface, app-bar logo) are untouched: they're aria-hidden ornament, and the hero shows all four suits adjacently where position disambiguates them.

---

## 13. Session boundaries in the WebSocket hook (2026-07-31)

### Why this happened
Signing in again produced an `UNAUTHENTICATED — Invalid or expired session token` toast on a session that was working perfectly: connection online, catalog loaded, player signed in. Two separate defects, both of the same shape — state from a dead session leaking into the next one — met in `useGameConnection.ts`.

The obvious one was the toast. A rejected token produces `ERROR: UNAUTHENTICATED` followed by an `AUTH_FAILED` close; the close sets `sessionExpired` and `App` correctly signs the user out. But `lastError` had already captured the error, and the effect that rebuilds the socket on a token change cleared `sessionExpired` and nothing else. The toast only renders on the signed-in branch, so it waited out the sign-in screen and appeared on the *next* session — complaining about a token that was already gone. Local dev makes this near-constant: with no `MONGODB_URI` the session store is in-memory, so every backend restart invalidates whatever is in `localStorage`.

The subtler one was structural. `disposedRef` was a single ref shared across every run of the effect, used to mean "this socket is finished." React runs the cleanup and the next effect back to back on a token change, but a socket's `close` event lands a tick later — by which point the shared ref has been reset to `false` for the *new* session. The abandoned socket therefore read itself as live, scheduled a reconnect with the previous token, overwrote `wsRef`, and got rejected — orphaning the real socket and signing the player out seconds after they signed in. StrictMode's double-mount runs this path on every dev page load.

### What changed
The disposal flag is now a `let cancelled` closed over by exactly one run of the effect, so it can never be revived by a later one. On top of that, each socket's callbacks check `wsRef.current === ws` before touching anything shared — the heartbeat timers in particular are per-hook, not per-socket, so a superseded socket clearing them would have silently disabled dead-link detection for the live one. A superseded socket now closes itself on open and stays quiet otherwise.

`lastError` and `games` are reset both when a session begins and when it ends. `UNAUTHENTICATED` is no longer surfaced as a toast at all: it always means the session is over, the sign-out already communicates that, and `AuthScreen` now carries the reason ("Your session has expired. Please sign in again.") in accent rather than the red reserved for things the player got wrong. The same code is logged to the console for debugging.

`send()` also now queues until `AUTHENTICATED` rather than until the socket is merely `OPEN`. The server answers anything that arrives before the handshake with the *other* `UNAUTHENTICATED` ("Send AUTHENTICATE before any other message"), which reached the player as the same opaque toast; the `AUTHENTICATED` handler already flushes that queue, so this closes the window rather than adding a mechanism.

### What this deliberately does not do
No test covers it. The frontend workspace has no test runner at all, and standing up vitest + jsdom + a mock WebSocket to assert on this hook is a larger piece of work than the fix. Worth doing if this hook keeps producing bugs — it is the most timing-sensitive file in the project and the only one where React's lifecycle and a network lifecycle have to agree.

---

## 14. Server-assigned plugin ids, and an immutable default catalog (2026-07-31)

### Why this happened
`rules.json` declared its own `"gameId"`, and that one string was doing three unrelated jobs: the in-memory registry key, the database `_id`, and the URL path segment for edit/delete. Because identity was authored inside the content, writing a plugin meant *claiming a name in a namespace shared with every other user and with the server's own defaults*.

Three things followed from that, and all three were felt as bugs rather than design:

1. **Importing was a naming contest.** A file whose id was taken came back 409, with an "overwrite?" prompt as the only way forward. Adding a game shouldn't require negotiating with games you can't see.
2. **You could not keep a variant next to its original.** Importing the same rules.json twice was definitionally a conflict, so "Callbreak, but 7 hands" had to replace Callbreak or be hand-renamed inside the JSON.
3. **The shipped games were writable.** 29 and Callbreak sat in the same flat namespace with no protection, and `importPlugin(..., overwrite: true)` would rewrite their files on disk while `deletePlugin` would `rm -rf` their directory — for *any* signed-in user. The default catalog could be destroyed by a stray import.

### What changed
Identity became the server's to assign, and the DSL stopped carrying it.

- **`RulesDsl.gameId` is gone, and `validateRulesDsl` now *rejects* a document containing one** rather than ignoring it. A silently-dropped field would let an author believe they had named their game and then hand them a different id with no explanation; the error is where that misconception gets corrected.
- **A built-in is identified by its folder name.** `backend/src/games/callbreak/` → `"callbreak"`. Chosen over minting ids for built-ins too, because those ids have to survive restarts: persisted matches and decision logs reference them, and with no `MONGODB_URI` the repository is in-memory, so generated ids would be fresh on every boot and every historical record would dangle.
- **An imported plugin is identified by an id `PluginRepository.create` mints** and returns — a real Mongo `ObjectId` (no `_id` supplied, so the server generates it) or a `randomUUID` in the in-memory sibling. `save` split into `create`/`update` precisely so that only one of them can invent an id.
- **Import always creates; editing moved to `PUT /api/plugins/:gameId`.** With nothing in the document claiming identity, POST has nothing to collide with, so `PluginConflictError`, the `overwrite` flag and the whole confirm-and-retry dialog were deleted rather than rehomed. The same file imported twice is now simply two games.
- **Built-ins are immutable.** `PluginProtectedError` (403) on edit or delete. `PluginManager` no longer writes to or removes anything from disk at all — `mkdir`/`writeFile`/`rm` are gone, and the shipped catalog is read-only server content in the same sense the source tree is.
- **`GameState.gameId` is now passed into `createMatch` explicitly** instead of being read off the rules. Easy to miss: it was the one place the DSL's id had leaked into match state rather than into the plugin layer.

### Customising a shipped game still works — as a fork
The headline "users edit rules.json to change how a game plays" feature was the reason built-ins were editable in the first place, so it needed somewhere to go. It became a fork: read a built-in's source, change it, import it, and you get a private copy with its own id while the original is untouched. `GET /api/plugins/:gameId` returns a `builtIn` flag so the edit panel can open in that mode directly ("Save as my own copy") instead of letting someone type into a form whose save is going to 403. The Lobby shows no delete button at all on a built-in — a button that always fails is worse than no button.

The row's icon follows the same rule, corrected after the fact: a built-in kept showing the **pencil**, which everywhere else in this app means "edit this in place" — so the row still advertised an edit the server would always refuse, no matter how carefully the panel behind it explained the fork. It now shows a copy glyph, titled "Make your own copy of X — the built-in stays as it ships". The affordance has to carry the constraint; a correct modal two clicks later does not undo a button that promised the wrong thing.

Copy then stopped being a built-in consolation prize and became its own verb, available on every row. On a game you own, "edit" and "copy" are genuinely different intentions — replace this, versus keep this and try something — and only the second one lets you experiment without risking a version that already works. So the panel takes an explicit `intent: 'edit' | 'copy'` rather than inferring it from `builtIn`, with a built-in still forcing `copy` because it has no other option. `copy` always POSTs, so the original is untouched whatever it was, and the form is pre-seeded with `displayName: "<name> (copy)"` so the list doesn't fill up with identically-named rows — a suggestion sitting in an editable textarea, not a rule.

One layout consequence worth recording: the panel lives at the *bottom* of the right-hand column, so a button in the left-hand list was filling in a form well below the fold. Opening it now scrolls it into view (`block: 'start'`, and `behavior: 'auto'` when the viewer prefers reduced motion). A control that silently does its work off-screen reads as a control that did nothing.

This is strictly better than what it replaces. The old flow let one user's edit change the game for everyone, permanently and destructively; the new one makes personal variants cheap and leaves the defaults intact.

### What this deliberately does not do
No migration for plugins imported under the old scheme. The original plan was to let them lapse — their documents have string `_id`s where the new code mints `ObjectId`s, so `findById` returns null and they were expected to quietly stop appearing.

**They did not lapse quietly** (found 2026-07-31, same day). `toStored()` called `doc._id.toHexString()`, which exists only on `ObjectId`, so merely *listing* the catalog of an account that owned one threw a `TypeError` — through `LIST_GAMES`, out to the client as `INTERNAL`, with no games in the response at all. The account lost its built-ins too, because the catalog is one response and one bad row failed the whole thing. "Old data becomes invisible" and "old data is a live grenade under an unrelated feature" are very different outcomes, and only the first one is safe to plan around.

The position changed as a result: the repository now *reads* both id shapes (`idToString`, `idFilter` with `$in`), so legacy plugins work everywhere a minted one does — list, open, edit, delete. That is cheaper than a migration and strictly safer than either the original plan or a rewrite of live `_id`s, which would have orphaned any persisted match referencing the old id. Still no migration, and the DSL is unchanged: new imports get minted ids exactly as designed, and nothing writes a string `_id` any more. Built-in games were never affected, their ids being folder names already.

The general lesson is in `summaries()` now rather than in this decision: it builds each entry in a `try`/`catch` and drops what it cannot summarise, with a warning naming the plugin. A per-user catalog assembled from user-supplied content should degrade by one row, never by all of them.

Also unchanged: nothing reconciles a repository id that happens to collide with a built-in's folder name. A folder would have to be named exactly like a UUID or a 24-character hex string for it to matter, and `loadAll` validates folder names, so the practical risk is nil.

---

## 15. How to keep this doc useful

Update this file (not just memory) whenever you: add a new reference plugin, change a provider, flip a major architectural decision (e.g. finally standing up Redis for real, moving to JWT, adding OAuth), or close one of the outstanding action items above. The value of this document is entirely in the "why," which git history and code comments don't capture on their own — a diff shows *what* changed, this file is where *why* lives.
