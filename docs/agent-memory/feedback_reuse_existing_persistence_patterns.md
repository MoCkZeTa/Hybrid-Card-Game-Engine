---
name: feedback-reuse-existing-persistence-patterns
description: User wants new persistence/caching designs to mirror this repo's existing Repository + cache patterns rather than invent new ones, and rejects storing user-generated data on local server disk
metadata:
  node_type: memory
  type: feedback
  originSessionId: 2c37c536-b84a-4e98-9732-af5ddc90600e
  modified: 2026-07-31T06:29:16.664Z
---

Two rules, both surfaced while designing per-user plugin visibility ([[project-hybrid-card-game-status]], PROJECT_JOURNAL.md §11):

1. **User-generated data never goes on a node's local disk in this project — it goes in the database**, behind the existing `InMemory*`/`Mongo*`-behind-one-interface convention (`MatchRepository`, `UserRepository`, now `PluginRepository`). The user rejected a first-draft design that persisted imported plugins as a disk file next to the built-in games, even after being told it "matched existing plugin storage" — built-in games are shipped server code (fine on disk, read once at boot); anything a *user* creates at runtime is data and belongs in Mongo so it survives a restart and isn't tied to one node in a multi-node deployment.

2. **Don't invent a second caching strategy when one already exists for the same shape of problem.** A first draft added an eager "warm this user's data into memory at login" hook plus a separate sync/async code-path split for different callers. The user pushed for "a better practice" instead of accepting it at face value; the fix was noticing `AuthService.validateToken()` already solves "cache in front of a DB-backed lookup" in this codebase (check cache → on miss consult repository → write through → return) and making the new code follow that exact shape rather than a bespoke one. Fewer code paths, no staleness window, no new wiring into unrelated modules (`auth-routes.ts`, `ws-server.ts`'s `AUTHENTICATE`).

**How to apply:** Before designing persistence or caching for anything new in this repo, grep for how the closest existing analog does it (`core/persistence/`, `core/auth/session-cache.ts`, `core/plugin/plugin-repository.ts` are the reference implementations) and match that shape rather than reasoning from scratch. When a plan proposes writing new user/runtime data to local disk, or adds a bespoke cache-warming mechanism, treat that as a signal to re-check against the existing pattern before presenting it — this user will ask "can you think of a better practice" rather than approve it as-is, and has consistently preferred the answer that turns out to be "reuse what's already here."
