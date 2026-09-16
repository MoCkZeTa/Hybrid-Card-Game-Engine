# TODO — Tier C games and the engine work they need

Trick-taking games that **cannot** be expressed by editing `rules.json` today.
Each one needs new engine or schema capability first; until then, writing a
plugin for it would produce a game that loads but plays wrongly, which is
worse than not shipping it.

Games that *can* be expressed are in `game-plugins/` (Tier A and Tier B) and
in `backend/src/games/` (29, Callbreak). Read `PROJECT_JOURNAL.md` for why the
DSL is shaped the way it is before adding to it.

## Ground rule

Every item below has to land as **DSL primitives plus engine support, never a
game-specific branch.** The moment `legal-moves.ts` or `scoring.ts` contains
`if (gameId === 'bridge')`, the plugin contract is broken and the promise that
a user can edit `rules.json` to get a different game stops being true. If a
mechanic cannot be named generically, that is a signal the abstraction is
wrong, not that a special case is warranted.

## Keep the AI game designer in step

Two files mirror this one, and both go stale silently:

- **`backend/src/core/authoring/dsl-reference.ts`** — `DSL_REFERENCE` teaches the
  model the vocabulary, and `DSL_LIMITATIONS` tells it what to refuse. When you
  land a primitive below, add it to the first and **delete its entry from the
  second**, or the designer will keep declining to produce games it can now
  express. `dsl-reference.test.ts` catches the additive half automatically (it
  reads the union types straight out of `rules-schema.ts`); it cannot catch a
  limitation that is no longer true.
- **`GAME_DESIGNER.md`** §3 quotes the blocked list.

The two entries that matter most are `CARD_EXCHANGE` and `microPhases` (§1
below): both are *declarable in the schema and generate no moves*, so a draft
using either passes validation and then deadlocks a real hand. Until the
interpreter exists, the designer must keep refusing to emit them.

---

## Missing primitives, ordered by how many games they unlock

### 1. Micro-phases (blocks the most)

`MicroPhaseRule` is already in the schema and `GameState.activeMicroPhase`
already exists, but nothing generates or applies moves for it —
`generateLegalMoves` returns `[]` when a micro-phase is active, and
`CARD_EXCHANGE` returns `[]` unconditionally.

Needed: a `micro-phase.ts` that generates the step's moves, an `apply-move`
path that advances `stepIndex` and exits the micro-phase when the last step's
`count` is exhausted, and a rule for whether the turn passes between steps.

**Unlocks:** Hearts' card-passing rotation (pass 3 left / right / across /
none, cycling by hand number — also needs a per-hand-index direction, since
the rotation is a property of the hand number). 3-2-5's between-hands card
pulling. Any draw-and-discard exchange.

Both shipped plugins that want it (`game-plugins/hearts`, `game-plugins/325`)
play correctly without it, just as simplified variants — see the caveats in
`game-plugins/README.md`.

### 1b. First-trick restrictions, and a declarable unlock condition

Two related gaps in `trickRules`, both exposed by Hearts.

**First-trick rules have no primitive at all.** Hearts requires that the Two
of Clubs leads the opening trick, and that no penalty card may be played on
that trick unless a player holds nothing else. Neither is expressible.
Roughly: a `trickRules.firstTrick` block naming a forced opening card and a
set of cards barred from that trick. Small, and it completes Hearts to the
standard rule set.

**`lockedLeadSuits` declares the lock but hardcodes the unlock.** The suits
are named in `rules.json`, but "unlocked once a card of that suit has been
played" lives in `apply-move.ts` and cannot be changed from a plugin. That is
correct for both games using it (Hearts, Spades), so it is not urgent — but
the asymmetry means a variant unlocking hearts only after the Queen of Spades
falls is unreachable. When a second unlock condition is actually needed,
widen the field to `[{ suit, unlockOn }]` rather than adding a sibling flag.

**Blocks:** standards-complete Hearts; Hearts variants with non-default
breaking rules.

### 2. Suit-dependent card ranking

`deck.rankOrder` is one global ordering. Several games re-rank cards *within*
the trump suit, and one re-assigns a card's suit entirely.

- **`deck.trumpRankOrder`** — a second ordering applied only to trump cards.
  Cheap; unlocks the right bower and most "J and 9 are high in trump" games
  beyond the uniform case 29 already handles.
- **Cross-suit promotion** — Euchre's *left bower*: the Jack of the same
  colour as trump becomes a trump card, and stops being a member of its
  printed suit for follow-suit purposes. This is genuinely hard, because it
  changes what "following suit" means, which touches `followSuitOptions`,
  `trickValue` and the fog-of-war card labels all at once.

**Blocks:** Euchre (both bowers), Klaberjass' trump ranking edge cases.

> Note: Euchre was originally scoped as a Tier A game. That was wrong — the
> left bower is not expressible, and shipping a bower-less Euchre would be a
> plugin that claims to be Euchre and is not.

### 3. Per-hand team topology

`players.teamsByCount` is static for a match. Several games decide sides
per hand.

- **Skat** — the auction winner plays alone against the other two, and who
  that is changes every hand. Needs teams derived from the declarer rather
  than declared up front.
- **Euchre's "going alone"** — the declarer's partner sits the hand out.
  Needs a seat to be skippable in turn order for one hand.
- **French Tarot** — the bidder may call a king, and whoever holds it becomes
  a secret partner, unknown until that card is played. Also needs the
  partnership to be *hidden*, which the fog-of-war layer has no concept of.

**Blocks:** Skat, Euchre (alone), French Tarot, Preferans.

### 4. Multi-dimensional bidding

`BiddingConfig` bids a single integer. Bridge bids a *level plus a
denomination* (including no-trump), with doubling and redoubling on top.

Needed: a bid shape that carries more than a number, an ordering over those
compound bids, and multiplier state that survives into scoring.

**Blocks:** Bridge, Skat (game values), French Tarot (bid tiers), Pinochle
(bidding variants).

### 5. Exposed hands (dummy)

Bridge's declarer plays their partner's hand face-up. The fog-of-war layer
masks strictly per seat, and turn order assumes the seat whose turn it is
chooses its own card.

Needed: a hand that is visible to everyone, and a seat whose moves are chosen
by a different seat. Both cut against `maskGameState`'s current one-viewer
model, so this wants design before code.

**Blocks:** Bridge.

### 6. Pre-play melding

A scoring sub-phase where players declare combinations from hand for points
before trick play starts. No `PhaseKind` or `ActionTypeName` covers "declare
a meld"; `PhaseKind` would need a new member and the move vocabulary a new
action.

**Blocks:** Pinochle, Bezique, Sixty-Six (marriages).

### 7. Structural trump suit

French Tarot has a fifth suit of 21 permanent trumps plus the Fool, which is
exempt from following suit. `deck.suits` is typed to the four standard
`Suit` values, so this is a change to the card vocabulary itself in
`shared/src/cards.ts`, not just to the DSL.

**Blocks:** French Tarot, Tarocchi.

---

## Game-by-game summary

| Game | Blocked on | Rough size |
| --- | --- | --- |
| Hearts (standards-complete) | #1 micro-phases (passing), #1b first-trick rules | Small — the plugin ships as a playable subset |
| 3-2-5 (with card pulling) | #1 micro-phases | Small — same |
| Euchre | #2 left bower, #3 going alone | Medium |
| Skat | #3 per-hand soloist, #4 game values | Large |
| Pinochle | #6 melding, #4 bidding | Large |
| Bridge | #4 bidding, #5 dummy | Very large |
| French Tarot | #7 fifth suit, #3 hidden partner, #4 bid tiers | Very large |

## Suggested order

1. **Micro-phases** — largest payoff per unit of work, completes two plugins
   that already ship, and the schema half is already written.
2. **`deck.trumpRankOrder`** — small, self-contained, and a prerequisite for
   thinking clearly about the bower problem.
3. **Per-hand team topology** — unlocks Skat and Euchre-alone, and is the
   right time to decide whether `teamKeyForSeat` should take the state rather
   than just the rules.

Bridge and French Tarot should be treated as their own projects, not
increments. Neither should be attempted before micro-phases and per-hand
topology exist, since both depend on them anyway.

## Not trick-taking at all

Poker, Teen Patti, Rummy, Blackjack and Andar Bahar are **not** in this list
and should not be added to `RulesDsl`. They have no tricks, no trump and no
follow-suit rule, so `trickRules`/`trump`/`deck.rankOrder` mean nothing to
them. They need a separate plugin family with its own schema — sharing only
`players` and `deck` out of `shared/` — rather than an extension of this one.
Forcing them into this DSL would make it worse at the games it currently does
well.
