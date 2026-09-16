/**
 * The `rules.json` DSL, written for a language model rather than for a
 * TypeScript compiler.
 *
 * This is the single most important file in the designer. A model cannot
 * author a document in a schema it has not been shown, and it will confidently
 * invent plausible-looking fields (`"trickRules": { "mustBeatHighest": true }`)
 * if the real vocabulary is left to its imagination. Everything the DSL
 * actually accepts is enumerated below, and everything it does not is named
 * explicitly — the negative half matters as much as the positive half, because
 * a hallucinated field produces a draft that *validates* while quietly not
 * doing what the author asked for.
 *
 * **This file must be kept in sync with `shared/src/rules-schema.ts`.**
 * `dsl-reference.test.ts` enforces the mechanical half of that: every
 * `TrumpMode`, `PhaseKind`, `ActionTypeName` and `ScoringFormula.kind` the
 * schema declares has to appear here, so adding a DSL primitive and forgetting
 * to teach the designer about it fails the suite rather than shipping a
 * designer that can never produce it.
 *
 * The prose is deliberately terse and example-heavy. Every token here is paid
 * for on every drafting call, and a schema is one of the few things a model
 * reads better as a dense reference than as an essay.
 */

/**
 * Field-by-field reference. Ordered the way a `rules.json` is written so the
 * model can follow it top to bottom while emitting.
 */
export const DSL_REFERENCE = `
## rules.json — complete field reference

A rules.json is ONE JSON object with exactly these top-level keys:
displayName, version, players, deck, trump, phases, trickRules, scoring
(required) and bidding, compoundActions, microPhases (optional).

NEVER include a "gameId" key. Identity is assigned by the server and a
document containing one is REJECTED. Name the game with "displayName".

### displayName, version
"displayName": string, non-empty — the name players see.
"version": string, e.g. "1.0.0".

### players
{
  "min": int >= 2,          // smallest table size supported
  "max": int >= min,        // largest; set max === min for a fixed-size game
  "defaultCount": int,      // must satisfy min <= defaultCount <= max
  "topology": "solo" | "fixed-pairs",
  "teamsByCount": { "4": [[0,2],[1,3]] }   // REQUIRED iff topology is "fixed-pairs"
}
teamsByCount is keyed by player count as a STRING, and every supported count
from min to max must have an entry that partitions every seat exactly once.
Seats are numbered clockwise from 0. Partners normally sit opposite:
4 players -> [[0,2],[1,3]]; 6 players -> [[0,2,4],[1,3,5]].

### deck
{
  "suits": ["S","H","D","C"],            // any subset, from S H D C only
  "ranks": ["2",...,"9","T","J","Q","K","A"],  // subset; Ten is "T", never "10"
  "excludedCards": ["7H","7S"],          // optional: remove single cards from the suits x ranks grid
  "deal": <DealConfig>,
  "rankOrder": [...],                    // ranks weakest -> strongest, same set as "ranks"
  "pointValues": { "J": 3, "9": 2, "A": 1, "T": 1 },  // capture value by rank; {} for pure trick games
  "suitPointValues": { "H": 1 },         // optional: value for EVERY card of a suit, ADDED to the rank value
  "cardPointValues": { "QS": 13 }        // optional: value for ONE card; OVERRIDES (does not add to) the two tables above
}

A card id is rank+suit, exactly two characters: "AS", "TH", "7D".

DealConfig is one of:
  { "mode": "even-split" }
      Deal as evenly as possible, remainder to the kitty. This is the mode
      that lets one plugin serve 3-6 players from one deck. Use it unless you
      need one of the others.
  { "mode": "fixed", "handSize": 8, "kittySize": 0, "biddingHandSize": 4 }
      Exact hand size. ONLY valid when players.min === players.max, and
      handSize * players + kittySize must equal the deck size exactly.
      "biddingHandSize" is optional and models a staged deal: players bid and
      pick trump seeing only that many cards, then the rest is revealed.
  { "mode": "schedule", "handSizes": [7,6,5,4,3,2,1] }
      A different hand size each hand, indexed by hand number, wrapping if the
      match outlasts the list. This is how a game deals down over a match.
      Whatever is left undealt becomes the kitty.

### trump
{ "mode": <TrumpMode>, ...mode-specific fields }

  "static"           one suit, every hand. REQUIRES "staticSuit": "S".
  "bid-selected"     the auction winner names it. Requires bidding.enabled
                     with "trump-suit" in bidding.determines, and a
                     TRUMP_SELECTION phase.
  "hidden"           the declarer names it but it stays concealed from everyone
                     (including the AI's own prompt) until a REVEAL_TRUMP
                     action fires. REQUIRES "hidden": { "allowConcealedLead": bool }
                     and a TRUMP_SELECTION phase.
  "none"             no trump at all; highest card of the led suit wins.
  "declared-by-lead" the suit led to the first trick of the hand becomes trump
                     for that hand.
  "chooser"          a seat fixed by POSITION, not by bidding, names trump
                     before play. REQUIRES "chooserDealerOffset": int, counted
                     clockwise from the dealer (0 = dealer). Needs a
                     TRUMP_SELECTION phase.
  "kitty-turnup"     the first undealt card is turned face up and its suit is
                     trump. REQUIRES a non-empty kitty, so pair it with
                     "schedule" or a "fixed" deal with kittySize > 0.

### bidding (omit the whole key for a game with no bidding)
{
  "enabled": true,
  "minBid": int,
  "maxBid": int,
  "allowPass": bool,
  "determines": ["trick-quota"] and/or ["trump-suit"],
  "style": "single-round" | "auction",     // default "single-round"
  "dealerMustBid": bool,                   // "auction" only
  "holdBidBySeniority": bool,              // "auction" only
  "forbidExactTotal": bool                 // "single-round" only
}

  "single-round": every seat acts exactly once. Use for games where each
      player independently states how many tricks they will take.
  "auction": a pass is permanent; an un-passed seat keeps getting turns and may
      raise. Ends when one un-passed bidder remains, who becomes declarer.
      "dealerMustBid" stops an auction ending with zero bids on the table.
      "holdBidBySeniority" lets a seat that opened earlier MATCH the current
      high bid instead of being forced above it.
  "forbidExactTotal": the last seat to bid may not pick the number that would
      make the bids total exactly the tricks available ("screw the dealer").

### phases
An ordered list forming a chain. Each entry:
  { "name": "PLAYING", "kind": <PhaseKind>, "next": "SCORING" | null }
"next" names another phase by name; exactly one phase ends the hand with null.

PhaseKind is one of: DEALING, BIDDING, TRUMP_SELECTION, CARD_EXCHANGE,
PLAYING, SCORING.

Every game needs at least DEALING -> ... -> PLAYING -> SCORING(next: null).
Include BIDDING iff bidding.enabled. Include TRUMP_SELECTION iff trump.mode is
"bid-selected", "hidden" or "chooser".

DO NOT emit a CARD_EXCHANGE phase: the engine does not yet generate moves for
it and a hand would deadlock there. See "not yet expressible" below.

### trickRules
{
  "mustFollowSuit": bool,
  "mustTrumpIfVoid": bool,               // void in the led suit -> must play trump if holding one
  "freeDiscardIfVoidAndNoTrump": true,   // effectively always true
  "mustOvertrumpIfPossible": bool,
  "mustTrumpAfterOwnReveal": bool,       // optional; hidden-trump games only
  "lockedLeadSuits": ["H"]               // optional; suits that may not be LED until one has been played off-lead
}

### scoring
{
  "contractBasis": "tricks" | "points" | "none",
  "maxHands": int,          // optional; how many hands make a match
  "targetScore": int,       // optional; first to this ends the match
  "formula": <ScoringFormula>,   // optional; see below
  "lowerIsBetter": bool,    // optional; the LOWEST total wins
  "bags": { "per": 10, "penalty": -100 },        // optional; requires the "bid-multiplier" formula
  "nil": { "bid": 0, "bonus": 100, "penalty": -100 },  // optional
  "moonShot": { "mode": "others-take-penalty" | "shooter-subtracts" },  // optional; requires "penalty-points"
  "fixedQuotasByDealerOffset": [2,3,5]   // optional; trick quotas by seat POSITION instead of by bidding
}

"contractBasis" says what a competitor's result is counted in: "tricks" counts
tricks won, "points" counts captured card value (deck.pointValues etc.),
"none" means there is no contract to check.

Omitting both maxHands and targetScore plays a SINGLE hand. Almost every game
wants one of them — set maxHands unless the game is explicitly first-to-N.

ScoringFormula is exactly one of these objects:

  { "kind": "bid-plus-overtrick-fraction", "overtrickValue": 0.1 }
      Make your bid, score it, plus a fraction per extra trick; miss it and
      lose the bid outright. Per seat.
  { "kind": "bid-multiplier", "madeMultiplier": 10, "overtrickValue": 1, "missMultiplier": -10 }
      Bid worth a multiple, overtricks a flat trickle, a miss costs the
      multiple. Per competitor, so partners' bids combine into one contract.
  { "kind": "exact-bid", "base": 10, "perTrick": 1, "missPerTrick": 0 }
      The bid is exact: over is as bad as under. Per seat.
  { "kind": "bid-difference" }
      Score the signed distance from your quota (+3 for three over, -1 for one
      short). A miss costs only the shortfall. Per seat.
  { "kind": "threshold-win", "threshold": 7, "value": 1 }
      Binary: reach the threshold, score "value"; fall short, score nothing.
      Per competitor.
  { "kind": "declarer-contract", "stake": "bid" | <number>, "defenders": "mirror" | "unaffected" }
      Only the declaring side has a contract. "stake" is what it is worth —
      "bid" stakes the bid value, a number stakes a flat amount. "defenders"
      says whether the other side takes the opposite result.
  { "kind": "capture", "threshold": 6 }
      No contract: score what you captured, optionally only the excess over a
      threshold.
  { "kind": "penalty-points" }
      Captured points are penalties. Pair with "lowerIsBetter": true.

Omitting "formula" defaults to "bid-plus-overtrick-fraction" for
contractBasis "tricks" and "declarer-contract" for "points". Be explicit.

### compoundActions (optional; only useful with a hidden trump)
[{
  "id": "reveal-and-play",
  "triggerPhase": "PLAYING",
  "actionSequence": ["REVEAL_TRUMP", "PLAY_CARD"],
  "conditions": [{ "kind": "trump-not-yet-revealed" }, { "kind": "hand-is-void-in-lead-suit" }],
  "atomic": false
}]
ActionTypeName: PLAY_CARD, PLACE_BID, PASS_BID, SELECT_TRUMP, REVEAL_TRUMP,
DISCARD_CARD, TAKE_CARD.
Condition kinds (all must hold): "trump-not-yet-revealed", "player-is-declarer",
"hand-is-void-in-lead-suit".
"atomic": false offers only the first action as its own move, letting the
player see the result before choosing the next one. "atomic": true fuses the
whole sequence into one indivisible choice.

### microPhases
Declarable but NOT YET EXECUTED by the engine. Do not emit this key.
`.trim();

/**
 * The honest limits. A designer that quietly produces a plugin for a game it
 * cannot actually express is the worst outcome available here — the draft
 * loads, plays, and is subtly not the game that was asked for. Naming the gaps
 * gets the model to say so instead, which the UI surfaces as a note.
 *
 * Sourced from `TODO.md`; when a primitive lands there, delete its entry here.
 */
export const DSL_LIMITATIONS = `
## Not expressible in this DSL (say so; do not fake it)

If the described game needs any of these, produce the closest faithful
SIMPLIFICATION that plays correctly, and list what you left out in "notes".
Never invent a field to cover a gap — an unknown field is ignored or rejected,
so the draft would silently play the wrong game.

- Passing or exchanging cards between players (Hearts' three-card pass,
  draw-and-discard). CARD_EXCHANGE and microPhases exist in the schema but the
  engine generates no moves for them: a hand entering that phase deadlocks.
- First-trick restrictions: forcing a specific opening card (Hearts' Two of
  Clubs), or barring point cards from the first trick.
- Card ranking that differs INSIDE the trump suit versus outside it, or a card
  that changes suit (Euchre's bowers, Skat/Klaverjas trump orders).
  "rankOrder" is one global ordering.
- Melds, marriages, sequences, or any score for cards HELD rather than
  captured (Bezique, Pinochle, Sixty-Six).
- Multi-round contract auctions with suit ranking (Bridge). "auction" style
  bids a single number.
- Per-hand variation in anything except hand size (deal.mode "schedule").
- Partnerships that change between hands (cutthroat/floating partners).
- Any bidding on something other than a number of tricks or points.
`.trim();

/**
 * One complete, valid document, shown as a worked example.
 *
 * Callbreak rather than 29: it is the simplest plugin that still exercises a
 * bid, a trump, a formula and a match length, so it anchors the shape without
 * teaching the model that every game needs an auction and a hidden trump. The
 * 29-flavoured machinery is described in the reference above for the cases
 * that genuinely need it.
 *
 * Inlined rather than read from `src/games/callbreak/rules.json` at runtime:
 * the built-ins are read-only server content and this is prompt text, so
 * coupling a network call's payload to a file read (which would then also need
 * a path that survives the `dist/` build) buys nothing.
 */
export const DSL_EXAMPLE = `
## Worked example — a complete, valid rules.json

{
  "displayName": "Callbreak",
  "version": "2.0.0",
  "players": { "min": 4, "max": 4, "defaultCount": 4, "topology": "solo" },
  "deck": {
    "suits": ["S", "H", "D", "C"],
    "ranks": ["2","3","4","5","6","7","8","9","T","J","Q","K","A"],
    "deal": { "mode": "even-split" },
    "rankOrder": ["2","3","4","5","6","7","8","9","T","J","Q","K","A"],
    "pointValues": {}
  },
  "trump": { "mode": "static", "staticSuit": "S" },
  "bidding": {
    "enabled": true,
    "minBid": 1,
    "maxBid": 13,
    "allowPass": false,
    "determines": ["trick-quota"],
    "style": "single-round"
  },
  "phases": [
    { "name": "DEALING", "kind": "DEALING", "next": "BIDDING" },
    { "name": "BIDDING", "kind": "BIDDING", "next": "PLAYING" },
    { "name": "PLAYING", "kind": "PLAYING", "next": "SCORING" },
    { "name": "SCORING", "kind": "SCORING", "next": null }
  ],
  "trickRules": {
    "mustFollowSuit": true,
    "mustTrumpIfVoid": false,
    "freeDiscardIfVoidAndNoTrump": true,
    "mustOvertrumpIfPossible": false
  },
  "scoring": {
    "contractBasis": "tricks",
    "maxHands": 5,
    "formula": { "kind": "bid-plus-overtrick-fraction", "overtrickValue": 0.1 }
  }
}
`.trim();

/**
 * What a good `strategy.md` is for. It is not documentation — it is injected
 * verbatim into the system prompt of the LLM that plays the AI seats, so it is
 * the entire difference between a bot that follows suit and a bot that plays
 * the game well.
 */
export const STRATEGY_GUIDE_BRIEF = `
## strategy.md — what it is for

strategy.md is NOT a rules restatement and NOT documentation. Its text is
injected verbatim into the system prompt of the model that plays the AI seats,
alongside a masked view of the current state and a bounded list of legal moves.
It is the only thing separating a bot that plays legally from one that plays
well, so write it as instructions TO that player.

Write it as markdown with these sections:
  # <Game> — Strategic Guide
  A short orientation paragraph: table size, teams, deck, what winning means.
  ## Core strategic principles   — 3-6 bullets on what actually decides hands.
  ## Role objectives             — how declarer / partner / defender differ.
                                   Omit for a game with no roles.
  ## Decision heuristics         — concrete, checkable rules of thumb tied to
                                   this game's specific cards and numbers.

Rules:
- Be specific to THIS game. "Play your high cards wisely" is worthless;
  "hold the Ace until the Jack and Nine have fallen, or you hand over four
  points in one trick" is not.
- Refer to cards the way the engine does: "AS", "TH", "9D".
- Never tell the player to make an illegal move; the engine hands it a bounded
  list and it can only choose from that.
- 400-900 words. Long enough to be useful, short enough to survive in a prompt
  alongside the game state.
`.trim();
