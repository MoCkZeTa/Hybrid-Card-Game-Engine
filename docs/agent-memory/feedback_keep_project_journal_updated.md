---
name: feedback-keep-project-journal-updated
description: User wants PROJECT_JOURNAL.md and PROBLEMS.md in the repo root kept in sync every time changes are made to the Hybrid Card Game project
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 338c5725-7ca2-4344-8bf5-bd54aba4c802
  modified: 2026-07-30T16:29:18.922Z
---

Two living docs in the repo root need to be kept current, proactively, not just when explicitly asked to document something:

- **`PROJECT_JOURNAL.md`** — the "why" record: history, architecture decisions, tech-stack tradeoffs. Update for new features, architecture/tech decisions, dependency or version changes, visual/UI reworks, test-count shifts, and closed action items.
- **`PROBLEMS.md`** — the "what went wrong" log: concrete obstacles hit, root cause, fix or open status (Problem → Root cause → Fix/current status format). Add an entry whenever something breaks, surprises you, needs a workaround, or a previously-open problem gets resolved.

**Why:** the user asked for both specifically as durable references they can use to revise/re-understand the project later ([[project-hybrid-card-game-status]]). Docs that silently drift out of sync with the code defeat their purpose — this already happened once with the journal (Phase 7's "Ink & Felt" UI rework replaced the "classic-luxury" look the journal still described, until caught and fixed).

**How to apply:** After any substantive code change (new feature, refactor with a real design decision behind it, dependency swap, UI pass, bug fix that took real diagnosis, etc.), update the relevant doc(s) in the same turn/session as the change — don't wait to be asked. Keep entries dated/additive rather than silently rewriting history, so both documents still read as timelines. Small non-decisions (typo fixes, formatting) don't need an entry in either.
