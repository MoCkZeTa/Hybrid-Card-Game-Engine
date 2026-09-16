# The AI game designer

> How "describe a card game in plain language, get a working plugin" is built, and
> why each piece is shaped the way it is. Companion to `PROJECT_JOURNAL.md` §19
> (the decision record) and `PROBLEMS.md` (what went wrong on the way).
>
> Read this before touching anything under `backend/src/core/authoring/`, and
> **especially** before editing `dsl-reference.ts`, which is the file most likely
> to be silently wrong.
>
> Verified against a live server on **2026-08-28**.

---

## 1. What it does

An author types a description of a card game. The server drafts a `rules.json`
and a `strategy.md`, **plays a real match of them** to prove they work, and hands
back the draft plus a verdict. The author refines it in further turns ("make it
three players", "add a nil bid"), edits either file by hand if that is quicker,
reverts to any earlier revision, and publishes when happy. Publishing puts the
game in their private catalog, ready to play.

The whole thing is one panel in the lobby (`frontend/src/components/GameDesigner.tsx`)
over eight REST endpoints (`backend/src/http/design-routes.ts`).

**What it is not:** a second way into the game catalog. A drafted game reaches
the catalog through `PluginManager.importPlugin` / `updatePlugin` — the exact
call an uploaded `rules.json` makes. There is one gate, and the LLM does not get
its own.

---

## 2. The core problem, and the shape of the answer

The engine's founding discipline is the **zero-hallucination principle**: the
engine produces a bounded set of legal moves, the LLM picks one identifier from
it, and anything outside that set is discarded in favour of `legal_moves[0]`
(`core/ai/decide.ts`). The model is never trusted; it is *constrained*.

Authoring breaks that pattern, because a `rules.json` is not a choice from a
list. There is no bounded set to pick from and no known-good document to fall
back to. So the same guarantee is rebuilt from the other direction:

| Play (`decide.ts`)                     | Authoring (`game-designer.ts`)                          |
| -------------------------------------- | ------------------------------------------------------- |
| Engine hands the model a bounded set    | Model is shown the exact schema and its limits           |
| Output must be a member of that set     | Output is validated *and played* by the engine           |
| Out-of-set → `legal_moves[0]`           | Invalid → errors handed back, bounded repair attempts    |
| Never stalls the game loop              | Never returns nothing — a failed draft comes back with its diagnostics |

Four files carry that:

```
core/authoring/
  dsl-reference.ts    what the model is allowed to write, and what it must not
  draft-validator.ts  the gate: structural validation + a real playthrough
  game-designer.ts    the loop: prompt → parse → validate → repair
  design-service.ts   sessions, ownership, revisions, publishing
```

---

## 3. `dsl-reference.ts` — the part most likely to rot

A model cannot author a document in a schema it has never seen. Shown nothing,
it invents plausible vocabulary — `"trickRules": { "mustBeatHighest": true }` —
and the result is worse than a syntax error, because **an unknown field is
ignored rather than rejected**. The draft validates, plays, and is quietly not
the game that was asked for.

So the file enumerates the entire DSL: every `TrumpMode`, `PhaseKind`,
`ScoringFormula`, `DealConfig`, `ActionTypeName` and `CompoundCondition`, with
the cross-field requirements spelled out ("`static` REQUIRES `staticSuit`").

### The negative half matters as much

`DSL_LIMITATIONS` names what the DSL *cannot* express — card passing, first-trick
restrictions, suit-dependent ranking, melds, Bridge-style auctions — sourced from
`TODO.md`. Two of those are the dangerous kind: `CARD_EXCHANGE` and `microPhases`
are **declarable in the schema but generate no moves**, so a draft using them
passes every structural check and then deadlocks the moment a hand reaches that
phase. The model is told explicitly not to emit them.

The instruction the model is given for anything it cannot express is: produce the
closest faithful simplification, and say what you left out in `notes`. That is
what makes the feature honest. Asked for full Hearts, it returns a playable
Hearts and the notes:

```
- Card passing phase not supported; game omits the 3-card pass.
- First-trick restriction (no point cards) cannot be enforced by the engine.
```

### Keeping it in sync

**`dsl-reference.test.ts` reads `shared/src/rules-schema.ts` as text**, extracts
the members of each union type, and asserts every one appears in the reference.
Add a primitive to the DSL and forget to teach the designer about it, and the
suite fails — instead of shipping a designer that can never produce it, a failure
that looks from the outside like a model that just isn't very good.

It also parses the worked example and runs `validateRulesDsl` on it, because a
malformed example is worse than none: it is the single most closely copied part
of the prompt.

**When you add a DSL primitive, update `DSL_REFERENCE`. When you implement one
that was blocked, delete its entry from `DSL_LIMITATIONS` and from `TODO.md`.**

---

## 4. `draft-validator.ts` — why validation is not enough

`validateRulesDsl` answers "is this document well-formed". That is the right
question for a file a person hand-wrote and can debug. A model fails differently:
it produces documents that satisfy every field constraint and still cannot be
played.

So a draft is checked the only way that proves anything — the engine deals it and
plays it:

- `createMatch` → `generateLegalMoves` → `applyMove` → `applyHandScoring`, the
  same loop the WebSocket server runs, taking `legal_moves[0]` every time.
- **At every table size the plugin claims to support.** A game declaring 3–6
  players is played four times.
- **Two hands, not one.** Hand two is what catches a `schedule` deal whose second
  entry is wrong, or a dealer rotation that redeals badly.
- **Fixed seeds.** The verdict has to be deterministic or the repair loop chases
  ghosts and the author is told their game is broken only sometimes.

This is exactly what `core/engine/game-library.test.ts` does to the shipped
plugin catalog. The designer holds its own output to the same bar.

Failure messages are written to be *actionable*, because they go straight back
into the repair prompt:

```
no legal move exists in phase "EXCHANGE" (kind CARD_EXCHANGE) for seat 0 — the hand cannot continue
```

A model given that fixes it nearly every time. A model given "invalid" does not.

### Warnings vs errors

Errors block publishing. Warnings never do — each is a judgement call, and
blocking on a judgement call means arguing with an author who knows what they
want. Current warnings: a match that is only one hand long, `contractBasis:
"points"` with no card carrying points, `pointValues` set on a trick-scored game,
`bags`/`moonShot` paired with a formula that ignores them, `penalty-points`
without `lowerIsBetter`, undealt cards nothing uses, and a strategy guide under
120 words.

---

## 5. `game-designer.ts` — the loop

```
buildSystemPrompt(mode, includeStrategy)   ← reference + limits (+ example, + strategy brief)
buildUserPrompt(request)                   ← brief, prior draft, earlier briefs
        ↓
provider.complete({ json: true, maxTokens })
        ↓
parseDesignResponse(raw, carriedStrategy)  ← tolerant: fences, preambles, missing keys
        ↓
validateDraft(rules, strategy)
        ↓
valid?  → return
invalid → buildRepairPrompt(...)  → loop, up to maxRepairAttempts (default 2)
        ↓
out of attempts → return the draft anyway, with its diagnostics
```

That last line is deliberate. An author who gets a broken draft *and can see what
is broken about it* can fix the one field by hand; an author who gets an error
message and an empty editor cannot do anything at all.

### Context discipline

The prompt is not the same every turn, for two reasons — one economic, one about
prompt quality.

The reference alone is ~3700 tokens, and **Groq charges the reply ceiling against
the same per-minute budget as the prompt**, up front. On a modest tier the two
together decide whether the request is answered at all (see §7). That makes "send
everything every time" a real cost rather than a safe default.

It is also weaker prompting. On a refine, the model is holding a valid document
it wrote itself:

- **The worked example is dropped.** Its own current draft is a better and more
  relevant example than Callbreak.
- **`strategy.md` is carried forward, not round-tripped.** It is not sent in the
  prompt and not asked for in the reply unless the author's instruction is
  actually about the guide (`briefConcernsStrategy`). The server substitutes the
  existing one. This saves ~1400 tokens in each direction *and* removes a failure
  mode: a rules tweak can no longer quietly rewrite a strategy guide the author
  was happy with.

### Treating the response as hostile

`parseDesignResponse` assumes nothing. `extractJsonObject` scans for the
outermost balanced `{...}` while respecting string literals — so a brace inside
the strategy text cannot end the scan early, which the naive "first `{` to last
`}`" approach gets wrong. A truncated reply is reported as *"the reply was
probably cut off by the token limit"*, not as "invalid JSON", because the latter
sends the reader looking for a syntax error that is not there.

A `gameId` the model emitted despite being told not to is **stripped**, not
rejected. `validateRulesDsl` refuses one outright, which is right for a human
author who needs to learn that identity is the server's to assign — but spending
a repair attempt teaching a model the same lesson is waste.

Model-authored content is capped before storage (24k chars of strategy, 32k of
rules, 12 notes). `strategy.md` is untrusted text that ends up in *another*
model's system prompt; the zero-hallucination contract contains the damage — that
model can only return one id from a bounded list — so the cap is about cost and
context exhaustion rather than hijacking.

---

## 6. `design-service.ts` — sessions

Three rules live here rather than in the route layer.

**Ownership.** A session belongs to its creator. Someone else's id gets the same
`DesignNotFoundError` → 404 that a nonexistent id gets — never a 403, which would
confirm it exists. Same reasoning as `PluginManager.getVisible`.

**Publishing goes through `PluginManager`.** This service never writes to
`PluginRepository` itself.

**History is append-only.** Reverting to revision 2 appends the old draft as
revision 5; it does not truncate. Undo that destroys the thing being undone is
only useful once — this way an author can revert to 2, decide they preferred 5,
and revert again. Revision numbers are stable identifiers, so trimming past
`MAX_REVISIONS_PER_SESSION` (40) drops the oldest and keeps counting up rather
than renumbering.

Publishing the first time imports (minting a `gameId`); every publish after that
**updates that same game**, so iterating does not litter the lobby with
near-identical entries. If the published game has since been deleted, it
re-imports rather than failing — the author's intent ("put this in my catalog")
is satisfied either way. Deleting a *session* never deletes a game published from
it.

Storage follows the project's `InMemory*`/`Mongo*`-behind-one-interface
convention (`design-session-repository.ts` /
`mongo-design-session-repository.ts`), indexed on `{ ownerUserId, updatedAt }`.
Sessions are node-agnostic, so nothing here interacts with match ownership or
the Redis layer.

---

## 7. Configuration, and the token budget trap

The designer reuses whichever provider `LLM_PROVIDER` selects and the same key
pool — there is no extra key to obtain.

| Variable | Default | Notes |
| --- | --- | --- |
| `DESIGNER_MODEL` | `openai/gpt-oss-120b` (Groq), `gemini-2.0-flash` (Gemini) | Separate from `GROQ_MODEL` on purpose |
| `DESIGNER_MAX_TOKENS` | `8000` | **Read the warning below before raising** |
| `DESIGNER_TIMEOUT_MS` | `90000` | |

`DESIGNER_MODEL` is deliberately not `GROQ_MODEL`. A game seat wants the fastest
model that can pick one id out of a list; drafting a hundred-line
schema-conformant document wants the most capable model available. They are
different jobs with opposite tradeoffs.

### The trap

**Groq charges `max_tokens` against your tokens-per-minute budget up front,
whether or not the reply uses it.** On a free tier capped at 8000 TPM, a
~4000-token prompt plus a generous ceiling is refused with a **413 before a
single token is generated**:

```
Request too large for model `openai/gpt-oss-120b` ... on tokens per minute (TPM):
Limit 8000, Requested 20190
```

Relayed raw this reads as "your prompt is too big", and the operator goes and
shortens their prompt — the one change that will not fix it. `describeGroqFailure`
in `groq-provider.ts` rewrites it to name the actual lever.

Two things worth knowing:

- **`groq/compound` is not an escape hatch.** It advertises a 70000 TPM limit,
  but it proxies to `openai/gpt-oss-120b` and its calls are charged against
  *that* model's 8000 budget. Verified directly; the rate-limit error names
  gpt-oss-120b.
- **A TPM 413 is retryable across keys.** The budget belongs to the Groq
  *organization* that owns the key, and a pool assembled from several accounts
  spans several organizations — so unlike most 413s, this one frequently
  succeeds on the very next key. `isWorthRetryingOnAnotherKey` allows it. It
  cannot rescue a single request that exceeds *any* org's limit, though.

**On a free 8000 TPM key, set `DESIGNER_MAX_TOKENS=3200`.** Below ~2000 the first
draft of a session truncates mid-JSON every time, and `config/env.ts` warns about
it. On a paid tier, 8000.

### No degraded mode

Every other optional dependency in this server degrades: no Mongo means memory,
no Redis means single-node, no LLM key means `legal_moves[0]`. The designer has
no equivalent — "author a card game with no language model" has no fallback. So
`GET /api/design` reports availability, and the client renders **nothing at all**
rather than a button that always fails. `createDesignerProviderFromEnv` returns a
reason string, which the boot log prints and the endpoint relays.

This is why a missing key is advisory even under `NODE_ENV=production`: the
designer is an authoring convenience, not a correctness guarantee, and refusing
to boot over it would take a whole deployment down for a missing nice-to-have.

---

## 8. HTTP surface

All eight routes require a bearer token except `GET /api/design`.

```
GET    /api/design                            availability + model label (public)
GET    /api/design/sessions                   your sessions, newest first
POST   /api/design/sessions        {brief}    create + draft revision 1      [throttled]
GET    /api/design/sessions/:id               full session with revisions
DELETE /api/design/sessions/:id               delete the session (not the game)
POST   /api/design/sessions/:id/refine {brief}  append a revision            [throttled]
PUT    /api/design/sessions/:id/draft  {rules, strategy}   hand-edited draft
POST   /api/design/sessions/:id/revert {n}    append a copy of revision n
POST   /api/design/sessions/:id/publish       import or update the game
```

Status codes: 404 for someone else's session (never 403), 400 for a rejected
brief or an unpublishable draft (with `reasons[]`), **502** for a model failure
or timeout — the fault is upstream, the caller's request was fine — 429 when
throttled, 503 when the designer is not configured.

`DESIGN_RULE` throttles the three model-calling routes **per user id**, not per
IP: the cost is attributable to an account, and an IP bucket would put a
household behind one shared budget for a deliberately iterative feature. Six in a
burst, then one every 20 seconds.

---

## 9. The UI

`GameDesigner.tsx` is a conversation, not a form. That shape does real work: a
first description of a game is essentially never complete, so the useful unit is
a turn — say what to change, see the new draft, say the next thing.

Three things it deliberately shows rather than hides:

- **The generated JSON, editable.** The premise of this whole app is that a game
  is data you can edit. Hiding it behind a chat bubble would make the AI the only
  way to change a game it authored. A hand edit goes through the same
  `validateDraft`, and lands as its own revision.
- **Diagnostics from a real playthrough.** "Plays correctly" is a fact here, not
  a promise.
- **What the model could not express**, plus how many repair attempts it took —
  the honest signal that the first answer was wrong and got corrected.

The draft editor is remounted per revision (`key={sessionId:n}`), so an
in-progress edit is never overwritten mid-typing, and a newly arrived AI revision
always wins over stale editor text — the right way round, since the author just
asked for that change.

---

## 10. Testing

63 tests across four files in `core/authoring/`, all offline — the interesting
behaviour is what happens when the model returns something *wrong*, and a live
model cannot be asked to be wrong on cue.

| File | Covers |
| --- | --- |
| `dsl-reference.test.ts` | schema-drift guard; the worked example is itself valid |
| `draft-validator.test.ts` | both shipped games pass; a `CARD_EXCHANGE` draft that validates and deadlocks is caught; determinism; every table size; each warning |
| `game-designer.test.ts` | repair loop; giving up gracefully; strategy carry-forward; fenced/preambled/truncated replies; braces inside strategy text; `gameId` stripping; timeout |
| `design-service.test.ts` | session lifecycle; ownership isolation; append-only revert; publish→import then update-in-place; re-import after deletion; refusal to publish a broken draft |

Verified live against a real Groq key on 2026-08-28: a partnership game drafted
valid and playable on the first attempt in 7.3s with zero repairs; a refine
adding bidding produced the correct `bid-multiplier` formula and `BIDDING` phase
in 5.5s with the guide carried forward; Hearts came back playable with the two
honest notes quoted in §3; publish, republish-in-place, cross-user 404 isolation,
and the rate limiter firing at exactly six requests all behaved as specified.
