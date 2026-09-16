---
name: project_hybrid_card_game_status
description: "Hybrid Card Game build status — production-ready; AI game designer shipped 2026-08-28; Groq free tier is the binding constraint on it"
metadata: 
  node_type: memory
  type: project
  originSessionId: d97f7807-378a-4f35-89fc-41b02449d512
  modified: 2026-08-28T06:17:37.591Z
---

Hybrid Card Game (LLM-driven trick-taking engine) is **production-ready**. Tests: 399/399 across 30 files; clean workspace typecheck and build (2026-08-28).

What was verified against real services (not mocks), and is recorded in `PROJECT_JOURNAL.md` §16 + `PROBLEMS.md` "Production readiness":
- Real Redis Cloud: `redis-integration.test.ts` 21/21; two server processes over one Redis+Mongo with cross-node play; hard-killed owner node recovered from snapshot by the survivor. This closed the long-standing OPEN "never run against real Redis" item.
- Real Resend send accepted; full reset-token lifecycle (enumeration-safe, single-use, session revocation) exercised against a live server.
- `NODE_ENV=production` config guard actually refuses to boot; single-origin `SERVE_STATIC=true` mode serves the SPA with working cold reset links.

Five production-only bugs were found and fixed — all invisible to the dev loop: `npm run build && npm start` never worked (`dist/games` was never copied); a missing `GROQ_API_KEYS` killed the boot despite two docs promising otherwise; the production frontend bundle hard-coded `ws://localhost:3001`; password reset had no landing page; `env.test.ts` didn't compile.

**AI game designer** (shipped 2026-08-28; `backend/src/core/authoring/`, documented in `GAME_DESIGNER.md`): describe a game in plain language, get a validated `rules.json` + `strategy.md`, refine over turns, publish. The non-obvious operational fact, which reading the code will not reveal: **this Groq account is capped at 8000 tokens/minute per organization, and Groq reserves `max_tokens` against that budget up front, before generating anything.** So `DESIGNER_MAX_TOKENS` is set to 3200 in `.env`; raising it to the code default of 8000 makes every drafting call fail with a 413. `groq/compound` is not a way around it — it proxies to `openai/gpt-oss-120b` and shares that model's budget, despite advertising 70000 TPM. Raise the ceiling only after upgrading the Groq tier.

**Still open, user action required:** rotate the Groq key, Atlas password, Redis Cloud password and Resend key (all have been in plaintext or a chat transcript). Verify a Resend sending domain before real users — `onboarding@resend.dev` only delivers to the account owner's own address. Consider switching `REDIS_URL` to the `rediss://` TLS endpoint.

See [[feedback_keep_project_journal_updated]] and [[feedback_reuse_existing_persistence_patterns]].
