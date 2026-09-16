---
name: user-js-experience-level
description: "Ankit's self-stated level is \"some basic JS\" — explain TypeScript, backend, Redis and auth concepts from JS fundamentals upward, never assuming them"
metadata: 
  node_type: memory
  type: user
  originSessionId: 8b2f2100-956c-4032-abcb-b325a94badc3
  modified: 2026-08-27T07:05:02.088Z
---

Ankit describes his level as "some basic JS." Not TypeScript, not backend architecture, not Redis or auth. He is preparing to be interviewed on the Hybrid Card Game codebase, so he needs to genuinely understand it rather than recite talking points — and he asks direct follow-up questions ("what is interface", "all tricks are not present in GameState?") that show he is reading the code closely, not skimming.

He is comfortable being taught from scratch and says so plainly. Treat that as an invitation, not an apology.

**Why:** The first `shared/` walkthrough was pitched at senior level — discriminated unions, exhaustiveness checking, ESM resolution — and missed completely; he replied that he only knows basic JS. The re-explanation that began with a plain-JS snippet and built up landed, and he kept going from there.

**How to apply:** Lead with a plain-JS "before" and then the TypeScript "after." Define jargon inline the first time it appears. Use concrete worked examples built from real data in this repo (a specific hand of 29, actual file contents) rather than abstract description. Prefer one running example carried across a whole explanation over many small disconnected ones. Don't talk down — he reasons well about design once the vocabulary is out of the way, and has independently spotted real gaps in the codebase. See [[feedback_collaboration_style]] for the wider preference for plain analogies.
