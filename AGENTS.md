# AGENTS.md

Guidance for any AI coding agent working in this repository (Antigravity, Claude Code, Cursor, Codex, Gemini CLI — all read this file, or can be pointed at it).

---

## Start here — every new session

1. Read this file end to end.
2. Read `PROJECT_JOURNAL.md` §9 (current status snapshot) and §7 (decision log table) — ~30 lines, gives you the state of the world.
3. Skim the section headings of `PROBLEMS.md` so you know what has already gone wrong here.
4. Then open only the topic doc for the area you are about to touch (registry below).

Do not read all thirteen documents at once — that is ~3,800 lines and most of it will not apply. The registry tells you which one is relevant. For the long ones, `grep -nE '^#{1,2} ' <file>` to get the section index, then read that section.

**Two standing obligations for every request, no exceptions.** They are the difference between this repo staying navigable and rotting:

- **The docs are part of the deliverable, not an afterthought.** A change is not done when the code compiles and the tests pass. It is done when `PROJECT_JOURNAL.md` and/or `PROBLEMS.md` reflect it. See "Documentation maintenance protocol" below.
- **Trust the code over the docs, then fix the doc.** Where a doc states a fact about the code (test counts, file names, versions), it was true when written. If you find a discrepancy, the code is right — correct the doc in the same session rather than leaving a known-wrong line in place.

---

## What this is

A Node.js/TypeScript engine that runs trick-taking card games (29, Callbreak) as plugins, with an LLM playing the AI seats. Three npm workspaces: `shared` (wire protocol + DSL types), `backend` (engine, AI, auth, clustering), `frontend` (React/Vite client).

---

## The document set

Thirteen markdown files carry the project's memory. Each entry below says what the doc is *for*, what is inside it, when to read it, and — critically — **when you are obliged to update it.**

### `PROJECT_JOURNAL.md` — the "why" record (875 lines)

**Purpose.** A single detailed record of what the project is, how it evolved, every major technical decision and the alternatives weighed against it. Written so the owner can re-read it cold in six months and reconstruct the reasoning without re-deriving it. Git history shows *what* changed; this file is where *why* lives.

**Contents.** §1 what this project is · §2 history · §3 tech stack and why each choice beat its alternatives · §4 architecture deep dive · §5 full repository map · §6 known gaps and stray files · §7 decision log (quick-reference table) · §8 environment variable reference · §9 current status snapshot · §10–19 dated feature narratives (Tier B DSL expansion, DB-backed private plugins, suit colours, WS session boundaries, server-assigned plugin ids, trick history and difficulty, production readiness, ending abandoned matches, per-tab sessions, the AI game designer) · §20 how to keep the doc useful.

**Read before.** Any non-trivial change. At minimum §7 and §9.

**Update when.** You add or change a feature; make or reverse an architecture decision; add, remove or upgrade a dependency; do a UI rework; change the test count; close an item from §6 or the open-items list. Add a **new dated section** at the end (`## 21. Title (YYYY-MM-DD)`) rather than editing an old one — the file reads as a timeline and rewriting history destroys that. Small corrections of fact (a renamed file in §5, a stale count in §9) are edited in place. Also update §8 whenever an environment variable is added, renamed or given a new default, and `.env.example` alongside it.

### `PROBLEMS.md` — the "what went wrong" log (281 lines)

**Purpose.** The companion to the journal. Concrete obstacles hit while building, why they happened, and how they were resolved or why they are still open. Its whole point is that a fix must not live only in a code comment or a chat transcript.

**Format, per entry.** **Problem** → **Root cause** → **Fix / current status**. Match it exactly.

**Contents, by section.** Security & WebSocket transport · Auth & sessions · AI / Groq integration · Database · Auth · Multi-node / clustering · Plugins · Frontend / table UI · Production readiness (2026-08-27) · AI game designer (2026-08-28) · Housekeeping / open items.

**Read before.** Debugging anything, and before proposing any design in an area you have not worked in — the odds are good the obvious approach was already tried and is recorded here as a failure.

**Update when.** Anything breaks, surprises you, needs a workaround, or reveals a footgun; a bug takes real diagnosis rather than being obvious; a previously-open problem gets resolved (edit that entry's status, don't delete it). File the entry under the existing section that fits; open a new dated section only for a genuinely new area. Do not log typos or trivia.

### `TODO.md` — the DSL's known limits (198 lines)

**Purpose.** Trick-taking games that **cannot** be expressed by editing `rules.json` today, and the engine primitive each is blocked on. Writing a plugin for one of these would produce a game that loads but plays wrongly, which is worse than not shipping it.

**Contents.** The ground rule (every item lands as DSL primitives plus generic engine support, never a game-specific branch) · keeping the AI game designer in step · missing primitives ordered by how many games each unlocks · game-by-game summary · suggested order · what is not trick-taking at all.

**Read before.** Adding any game, or extending `shared/src/rules-schema.ts`.

**Update when.** You add a DSL primitive (tick off what it unlocks and remove games it now covers); you discover a new game the DSL cannot express (add it with the primitive it needs); you are tempted to special-case a game in the engine — that impulse belongs here as a missing primitive, not in `legal-moves.ts`.

### `PRD.md` — the original spec (185 lines, historical)

**Purpose.** The product requirements document the project was built from: objectives, folder layout, plugin component specs, state-engine and move-generation requirements, AI payload guidelines, performance budgets and latency SLAs.

**Read before.** Questions about original intent or the performance budgets.

**Update when.** Essentially never. This is a historical artifact — where the build diverged from it, the divergence and its reason belong in `PROJECT_JOURNAL.md`, not in a rewritten PRD.

### `SCALING.md` — the multi-node story (196 lines)

**Purpose.** Why a card game cannot simply be load-balanced, and the mechanics of the layer that solves it.

**Contents.** Short version · why request-by-request balancing breaks a stateful match · presence and the crashed-node problem · game plugins across nodes · what the socket layer defends against · reconnection · deploying · what is not done.

**Read before.** Touching `core/cluster/`, presence, or reconnection.

**Update when.** Ownership, presence, reconnection or the socket defences change; an item under "what is not done" gets done.

### `DEPLOYMENT.md` — the operational companion (160 lines)

**Purpose.** How to actually run this in production.

**Contents.** Build and run order · environment · single-origin vs split-origin · running more than one instance · email · post-deploy checklist · security notes.

**Read before.** Any change to the build, `server.ts` boot, static file serving, or `backend/src/config/env.ts`.

**Update when.** The build order or start command changes; a new required-in-production variable appears; the static-serving or origin behaviour changes; the post-deploy checklist gains or loses a step. Production-only failures are common here (five were found in one session) — each one gets a `PROBLEMS.md` entry *and* a checklist line so it cannot recur silently.

### `AUTH.md` — the auth system end to end (453 lines)

**Purpose.** How authentication actually works, from the one decision everything else follows from.

**Contents.** §0 the founding decision · §1 the pieces · §2 registration · §3 sign-in · §4 validating a token · §5 the WebSocket handshake · §6 changing a password · §7 password reset · §8 the full journey · §9 threat model and what is deliberately *not* covered · §10 endpoint reference · §11 verifying it works.

**Read before.** Touching anything under `core/auth/`, `http/auth-routes.ts`, or the `AUTHENTICATE` path in `ws/ws-server.ts`.

**Update when.** An endpoint is added or its shape changes (§10 must stay exact); token lifetime, hashing or session revocation changes; the threat model shifts — if you add a defence, §9 must stop listing it as uncovered.

### `SESSION_TRANSPORT.md` — how the token travels (334 lines)

**Purpose.** The narrower question of cookies vs bearer tokens: CSRF vs XSS, why cookies are worst on a WebSocket handshake, and why this project keeps the token in Web Storage.

**Contents.** §0 the question · §1 what the transport must do · §2 cookies · §3 bearer token in Web Storage · §4 the hybrid · §5 WebSockets, the part that actually decides it · §6 what this project does and why · §7 summary table · §8 mistakes worth not repeating.

**Read before.** Adding any `Set-Cookie`, or changing how the socket authenticates. Non-negotiable — the decision here is reasoned, not accidental.

**Update when.** The transport decision is revisited. If you change it, §6 and §8 must change with it, or the next agent will reverse your change back.

### `SESSION_PERSISTENCE.md` — which storage, and for how long (213 lines)

**Purpose.** The session is per-tab in `sessionStorage`, with `localStorage` as opt-in "Keep me signed in", because one browser-wide slot silently signed players in as each other.

**Contents.** §0 the bug as observed · §1 root cause: the session was a browser-wide singleton · §2 the fix · §3 behaviour matrix · §4 what this does and does not fix · §5 verifying it · §6 mistakes worth not repeating.

**Read before.** Touching the storage functions in `frontend/src/api.ts`.

**Two non-obvious rules it explains:** adopt-on-read, and that *not* persisting **clears** the shared slot. Removing either quietly restores the wrong-identity bug **with no test failing.** Do not "simplify" that code without reading §2 and §3.

**Update when.** Storage scope or the persistence toggle changes; the behaviour matrix in §3 must match the code exactly.

### `REDIS.md` — all five Redis uses in depth (482 lines)

**Purpose.** Every use of Redis here, the Lua behind each, and how each degrades when Redis is absent or dies.

**Contents.** §0 Redis is optional and that is load-bearing · §1 why a card game needs it · §2 connection management · §3 match ownership leases · §4 the message bus · §5 rate limiting · §6 session cache · §7 cluster-wide connection counting · §8 what happens when Redis dies · §9 operating notes · §10 summary.

**Read before.** Touching `core/cluster/`, `core/redis/`, or **either sibling of any dual implementation** — changing the Redis one without the in-memory one is the classic failure here.

**Update when.** A new Redis use is added (it needs its own numbered section plus a §8 degradation entry); any Lua script changes; a key naming scheme or TTL changes.

### `GAME_DESIGNER.md` — the AI game designer (387 lines)

**Purpose.** The "describe a game, get a plugin" feature, end to end.

**Contents.** §1 what it does · §2 the core problem and the shape of the answer · §3 `dsl-reference.ts`, the part most likely to rot · §4 `draft-validator.ts`, why validation alone is not enough · §5 `game-designer.ts`, the loop · §6 `design-service.ts`, sessions · §7 configuration and the token budget trap · §8 HTTP surface · §9 the UI · §10 testing.

**Read before.** Touching `core/authoring/` or `http/design-routes.ts`.

**Update when.** The DSL grows a primitive (§3, and `dsl-reference.ts` itself — `dsl-reference.test.ts` enforces this by reading the union types straight out of `rules-schema.ts`); the repair loop or validation gate changes; the model, token budget or provider changes (§7 records *why* `DESIGNER_MAX_TOKENS` is 3200 — see the Groq trap under Project status).

### `game-plugins/README.md` — the plugin library

**Purpose.** The seven ready-to-use plugins at the repo root that are deliberately *not* loaded at boot, and how to install one.

**Update when.** A plugin is added to or removed from the library, or the install path changes.

### `docs/agent-memory/` — how the owner works

**Purpose.** Five notes carried over from Claude Code's memory: the owner's JS experience level, collaboration style, doc-upkeep expectations, and persistence/caching patterns already rejected. Summarised under "Working agreements" below; read the full files when a preference needs its reasoning.

**Update when.** The owner states a durable preference or corrects your approach in a way that should outlive the session. Add or edit the relevant file **and** its line in `docs/agent-memory/MEMORY.md`.

---

## Documentation maintenance protocol

This is the standing rule for every request from here on. It is not optional and it is not "if there is time."

**Definition of done.** Code compiles → tests pass → **docs updated** → then report. If you tell the owner a change is complete while a doc still describes the old behaviour, the change is not complete.

**Which doc gets the change:**

| What you did | Where it goes |
| --- | --- |
| New feature, or a real design decision | `PROJECT_JOURNAL.md` — new dated section |
| Something broke, surprised you, or needed a workaround | `PROBLEMS.md` — Problem → Root cause → Fix/status |
| Fixed a previously-open problem | `PROBLEMS.md` — update that entry's status; don't delete it |
| Dependency added / removed / upgraded | `PROJECT_JOURNAL.md` §3 |
| Env var added / renamed / re-defaulted | `PROJECT_JOURNAL.md` §8 **and** `.env.example` **and** `DEPLOYMENT.md` §2 if production-required |
| New file or moved module | `PROJECT_JOURNAL.md` §5 (repo map) |
| Test count changed | `PROJECT_JOURNAL.md` §9 |
| Touched auth, sessions, Redis, clustering, deployment, the designer | the matching topic doc, in the same session |
| DSL primitive added | `TODO.md`, `GAME_DESIGNER.md` §3, and `dsl-reference.ts` |
| Owner stated a durable preference | `docs/agent-memory/` + its `MEMORY.md` line |
| Typo, formatting, comment wording | nothing |

**How to write the entry.**

- **Dated and additive.** New journal sections are appended and numbered with an ISO date in the heading. Never silently rewrite an old section to match new behaviour — supersede it and say what changed. Both files are timelines; that is their value.
- **Record the why, not the diff.** The git log already shows what changed. Write the alternative you rejected and the reason, the constraint that forced the shape, the thing that surprised you. A journal entry that only restates the diff is worthless.
- **Verify facts before writing them.** Run the tests before quoting a count. Check the file exists before naming it. These docs are trusted precisely because their claims were checked, not recalled.
- **Cross-reference rather than duplicate.** If the detail lives in `REDIS.md`, the journal entry points at it. Two copies of the same explanation will drift.
- **Do it in the same session as the change.** Not batched, not "later", not only when asked.

**Before you finish any task, self-check:** which docs did my change make wrong? Did I update them? Did I add anything to `PROBLEMS.md` that cost me more than a few minutes to diagnose?

---

## Commands

Run from the repo root (npm workspaces: `shared`, `backend`, `frontend`).

```
npm install                          # installs all three workspaces
npm run dev:backend                  # tsx watch, backend on :3001
npm run dev:frontend                 # vite, frontend on :5173
npm run build                        # shared -> backend -> frontend, in that order
npm run typecheck                    # tsc --noEmit across all workspaces (see caveat)
npm run test                         # vitest run, backend workspace only
```

Backend-only, from `backend/`:

```
npx vitest run                       # full backend suite
npx vitest run src/core/ai/decide.test.ts   # one file
npx vitest run -t "name substring"   # one test by name
npx vitest                           # watch mode
```

**After changing a type in `shared/`, run `npm run build --workspace @hcg/shared` before typechecking anything else.** `backend`/`frontend` resolve `@hcg/shared` to `shared/dist/*.d.ts`, and `tsc --noEmit` never regenerates it — so `npm run typecheck` will happily check the dependent workspaces against the *previous* build's types and report a clean pass over code that no longer compiles.

A `.env` file at the **repo root** (not `backend/`) is required for `MONGODB_URI`/`GROQ_API_KEYS`/etc. — `server.ts` loads it from the repo root regardless of which workspace's `dev` script is running. Everything works with `.env` mostly empty: no `MONGODB_URI` falls back to in-memory storage, no `REDIS_URL` runs single-node, no `GROQ_API_KEYS` makes every AI turn play `legal_moves[0]`. `backend/src/config/env.ts` inverts all of these under `NODE_ENV=production`, where the same conditions refuse the boot instead. See `.env.example` for the full variable list.

There is **no lint script and no ESLint config** in this repo — don't assume `npm run lint` works.

---

## Architecture invariants

These are load-bearing. Breaking one is a design regression, not a bug.

**The plugin contract is the core constraint.** A game is a folder under `backend/src/games/<id>/` with `rules.json` (a DSL: deck, phases, trump mechanics, trick rules, scoring) and `strategy.md` (natural-language guidance injected into the LLM's system prompt). Adding a game must never require touching engine code — `PluginManager` (`core/plugin/plugin-manager.ts`) scans that directory at boot and validates against `shared/src/rules-schema.ts`. Games can also be imported/edited/deleted at runtime via `POST/GET/PUT/DELETE /api/plugins` (`http/plugin-routes.ts`), through the identical validation path.

**`rules.json` has no `gameId` — identity is the server's to assign,** and a document containing one is rejected. A built-in is identified by its **folder name** (stable across restarts, so persisted match records keep resolving, and it needs no database); an imported plugin by an id `PluginRepository.create` mints. Consequences: `POST /api/plugins` always *creates* (the same rules.json imported twice is two independent games), editing is `PUT /api/plugins/:gameId`, and `createMatch` takes `gameId` as an explicit option rather than reading it off the rules.

**The two shipped games (29, Callbreak) are immutable.** No user may edit or delete them — both answer `PluginProtectedError`/403 — and nothing in `PluginManager` writes to or removes anything from disk. Customising a built-in is a *fork*: read its source, change it, import it as your own private copy. Don't reintroduce a disk-write path for user content; imported plugins belong in `PluginRepository`.

**No engine file may branch on a `gameId`.** Users edit `rules.json` to change how a game plays — that is a headline feature — so a mechanic the engine special-cases is a mechanic they cannot touch. A game needing behavior the DSL can't express needs a new named DSL primitive plus generic support for it, not a conditional. `scoring.ts`'s formula table is the pattern to follow: a bounded set of named payout curves with constants, chosen from `rules.json`.

**`game-plugins/` at the repo root is a library, not a load path.** Seven ready-to-use plugins (3-2-5, Mendicot, Court Piece, Whist, Hearts, Spades, Oh Hell), validated and playthrough-tested by `core/engine/game-library.test.ts` but deliberately *not* scanned at boot — one bad edit in a browsable catalog would otherwise fail-fast the whole server. Install by copying into `backend/src/games/` or via the runtime import endpoint.

**Zero-hallucination principle.** The engine (`core/engine/legal-moves.ts`) is the sole authority on what moves are legal; the LLM only ever picks one identifier from that bounded list. `core/ai/decide.ts` is the one place that owns this contract: it times the LLM call against `LLM_TIMEOUT_MS`, and any timeout, error, or out-of-set response falls back to playing `legal_moves[0]` — the game loop can never stall on a flaky external API.

**The AI game designer is that principle rebuilt for authoring, not an exception to it.** `core/authoring/` lets a user describe a game in plain language and get a `rules.json` + `strategy.md` back. A document isn't a choice from a bounded list, so the guarantee is built from the other side: the model is shown the exact schema *and what the DSL cannot express* (`dsl-reference.ts`), every draft is validated **and actually dealt, played and scored by the engine** before a human sees it (`draft-validator.ts`), and failures go back to the model with the engine's own error strings for a bounded number of repair attempts. Two consequences to preserve: **nothing in `core/authoring/` may write to `PluginRepository` directly** — publishing goes through `PluginManager.importPlugin`/`updatePlugin`, the same gate an uploaded file passes, so there is one validation path rather than two that can drift; and `dsl-reference.ts` must be updated whenever the DSL grows a primitive, which `dsl-reference.test.ts` enforces by reading the union types straight out of `rules-schema.ts`. Unlike every other optional dependency here the designer has **no degraded mode** — authoring needs a generative call and there is no `legal_moves[0]` to fall back on — so with no API key `GET /api/design` reports itself unavailable and the client hides the feature rather than offering a control that always fails.

**Fog of war runs once, shared.** `core/obfuscation/fog-of-war.ts` masks a `GameState` per-seat before it goes into either an AI prompt or a WebSocket push — same function for both, so the AI-facing and client-facing masks can't drift apart.

**Dual in-memory/Redis implementations behind one interface, everywhere clustering touches.** `EventBus`, `OwnershipRegistry`, `RateLimiter`, `SessionCache`, `MatchRepository` each have a `Local*`/in-memory sibling and a `Redis*`/Mongo one. `server.ts` picks between them based on whether `REDIS_URL`/`MONGODB_URI` are set — same code path in dev and prod, not two that can drift. When touching any of these, keep both implementations in sync.

**One node owns each live match.** A match holds dealt hands in memory and runs its own AI-turn timer, so it can't be load-balanced request-by-request. `core/cluster/match-gateway.ts` routes commands to whichever node currently holds the TTL lease on that match (`core/cluster/ownership-registry.ts`), and republishes masked per-seat state over pub/sub. This only matters when `REDIS_URL` is set; single-node local dev never exercises it.

**Workspace boundaries.** `shared/` holds the wire protocol and DSL types (`protocol.ts`, `game-state.ts`, `moves.ts`, `rules-schema.ts`) with zero runtime dependencies — both `backend` and `frontend` import from it, so a type change there affects both sides of the socket. Don't duplicate a type that belongs in `shared/` into just one workspace.

---

## Working agreements with the repo owner

Full detail in `docs/agent-memory/`. The short version:

- **Explain from JS fundamentals upward.** The owner's self-stated level is "some basic JS" — not TypeScript, not backend architecture, not Redis or auth. Lead with a plain-JS "before" and the TypeScript "after"; define jargon inline the first time it appears; use one running example built from real data in this repo (a specific hand of 29, actual file contents) carried across a whole explanation, rather than many abstract ones. He reasons well about design once the vocabulary is out of the way and has independently spotted real gaps in this codebase. Don't talk down.
- **Use plain analogies for infra/AI plumbing** when explaining it — the LLM provider router landed as "wall socket vs lamp plug," not as an interface diagram. If an explanation misses, switch register rather than repeating it more technically.
- **For UI/visual work, do not offer options — just do it.** He reports symptoms ("empty white space below", "I have to scroll to bid") and expects the diagnosis, the design decision and the implementation to all come back done. Drive the real app, screenshot it, fix, re-screenshot until it is actually right.
- **Ask before irreversible or ambiguous setup choices** (persistence scope, framework, repo layout, provider scope) using direct structured questions — then proceed autonomously through the implementation without re-confirming each step.
- **Keep `PROJECT_JOURNAL.md` and `PROBLEMS.md` current in the same session as the change**, proactively. See the maintenance protocol above.
- **Reuse this repo's existing persistence/caching shapes; don't invent new ones.** User-generated data never goes on a node's local disk — it goes in the database, behind the existing `InMemory*`/`Mongo*`-behind-one-interface convention (`MatchRepository`, `UserRepository`, `PluginRepository`). Before designing any new cache, look at how `AuthService.validateToken()`, `core/auth/session-cache.ts` and `core/plugin/plugin-repository.ts` already solve the same shape (check cache → on miss consult repository → write through → return) and match it. A plan that writes runtime user data to disk, or adds a bespoke cache-warming hook and a second code path, is a signal to re-check against the existing pattern before presenting it.

---

## Project status (as of 2026-08-28)

**Production-ready.** 399/399 tests across 30 files; clean workspace typecheck and build.

Verified against real services, not mocks (recorded in `PROJECT_JOURNAL.md` §16 and `PROBLEMS.md` "Production readiness"):

- Real Redis Cloud: `redis-integration.test.ts` 21/21; two server processes over one Redis+Mongo with cross-node play; a hard-killed owner node recovered from snapshot by the survivor.
- Real Resend send accepted; full reset-token lifecycle (enumeration-safe, single-use, session revocation) exercised against a live server.
- `NODE_ENV=production` config guard actually refuses to boot; single-origin `SERVE_STATIC=true` mode serves the SPA with working cold reset links.

Five production-only bugs were found and fixed, all invisible to the dev loop: `npm run build && npm start` never worked (`dist/games` was never copied); a missing `GROQ_API_KEYS` killed the boot despite two docs promising otherwise; the production frontend bundle hard-coded `ws://localhost:3001`; password reset had no landing page; `env.test.ts` didn't compile.

**AI game designer** shipped 2026-08-28 (`backend/src/core/authoring/`, documented in `GAME_DESIGNER.md`). The non-obvious operational fact, which reading the code will not reveal: **this Groq account is capped at 8000 tokens/minute per organization, and Groq reserves `max_tokens` against that budget up front, before generating anything.** So `DESIGNER_MAX_TOKENS` is set to 3200 in `.env`; raising it to the code default of 8000 makes every drafting call fail with a 413. `groq/compound` is not a way around it — it proxies to `openai/gpt-oss-120b` and shares that model's budget, despite advertising 70000 TPM. Raise the ceiling only after upgrading the Groq tier.

### Open items — owner action required

- Rotate the **Groq key, Atlas password, Redis Cloud password and Resend key**. All four have been in plaintext or in a chat transcript.
- Verify a **Resend sending domain** before real users — `onboarding@resend.dev` only delivers to the account owner's own address.
- Consider switching `REDIS_URL` to the `rediss://` TLS endpoint.

---

## Prompt playbook

Copy-paste starting points. They exist because the quality of the first message decides whether the agent reads the right doc or guesses.

**First session in a new tool / after a long gap**

> Read `AGENTS.md`, then `PROJECT_JOURNAL.md` §7 and §9, then the section headings of `PROBLEMS.md`. Summarise back to me: what this project is, the architecture invariants I must never break, the current status, and which doc you would open before touching auth. Don't write any code yet.

**Before a feature**

> I want to add <feature>. First tell me which of the architecture invariants in `AGENTS.md` it touches, which topic doc you need to read, and whether `PROBLEMS.md` shows this was already attempted. Then propose an approach — no code yet. When we agree, implement it, run the tests, and add the dated `PROJECT_JOURNAL.md` section per the maintenance protocol.

**Before a bug fix**

> <symptom>. Check `PROBLEMS.md` first for whether this is known. Then find the root cause before proposing a fix — I want the cause, not a patch over the symptom. When it's fixed, add the Problem → Root cause → Fix entry.

**Learning a subsystem** (matches how the owner wants things explained)

> Explain <subsystem> to me. I know basic JS, not TypeScript or backend architecture. Start with a plain-JS version of the idea, then show what this repo actually does, using one real example from this codebase carried all the way through. Define jargon the first time you use it. Read <topic doc> first.

**Adding a game**

> I want a plugin for <game>. Check `TODO.md` first — if it's listed there, tell me which engine primitive is missing and stop. If the DSL can express it, write `rules.json` + `strategy.md`, validate it the way `game-library.test.ts` does, and do not touch any engine file.

**Doc-drift audit** (worth running monthly, or after any stretch of undocumented work)

> Compare `PROJECT_JOURNAL.md` §5 (repo map), §8 (env vars) and §9 (status) against the actual repo. List every claim that is now wrong — file names, test counts, variable names, versions. Don't fix anything yet, just show me the list.

**End-of-session check**

> Before we stop: which docs did today's changes make wrong, and did you update them? Show me the diff of the doc changes only.
