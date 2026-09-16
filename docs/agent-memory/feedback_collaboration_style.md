---
name: feedback-collaboration-style
description: How this user likes technical concepts explained and decisions handled on the Hybrid Card Game project
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e4aca350-30ed-46e1-9f71-8bbef268e1e8
  modified: 2026-07-30T15:06:23.693Z
---

Explain infrastructure/AI concepts in plain analogies ("explain like I am a child") when the user asks for it, not just terse technical prose — e.g. the Groq/Gemini provider router was explained as a wall socket vs. lamp plug, not as an interface diagram.

**Why:** user explicitly asked for a from-scratch, non-jargon explanation of the LLM provider router after an initial technical answer didn't land — asking "what is a router" isn't a sign they want less detail, it's a sign the register was wrong.

**How to apply:** When introducing a new technical concept (especially AI/infra plumbing distinct from gameplay logic they already understand from card games), default to a concrete real-world analogy first, then the technical name, rather than leading with terminology. Don't assume repeating the same explanation more technically will help — switch register instead.

**For UI/visual work specifically, do not offer options — just do it.** User: "don't suggest options just complete the ui task urself, i am going to eat." They report symptoms ("empty white spaces below", "I have to scroll to bid", "the W, B, C stuff is not nice") and expect the diagnosis, the design decision and the implementation to all come back done. **How to apply:** drive the real app with Playwright, screenshot it, fix, re-screenshot until it's actually right — don't hand back a plan or a menu of approaches.

Also confirmed earlier: user wants to be asked before irreversible/ambiguous setup choices (persistence scope, frontend framework, repo layout, LLM provider scope) via structured questions rather than having them silently decided — see [[project-hybrid-card-game-status]] for the specific choices this produced. Once asked and answered, proceed autonomously through implementation without re-confirming each step ("move ahead" was given once and covered the entire subsequent build-out).
