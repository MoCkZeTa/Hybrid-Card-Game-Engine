/**
 * The `rules.json` DSL (PRD section 3.1).
 *
 * This is the entire contract a new game plugin must satisfy. If a game can be
 * expressed as data matching `RulesDsl`, the engine runs it with zero code
 * changes. The three reference games chosen to prove this out are:
 *
 *  - 29:         hidden trump, atomic reveal-and-play compound action.
 *  - Callbreak:  static trump, must-follow-suit, no bidding for trump — bidding
 *                only sets a trick quota.
 *  - 3-2-5:      bid-selected trump, micro-phase card exchange.
 *
 * Keep this file dependency-free (no zod/ajv) — it is imported by the
 * frontend bundle too, and the validator below is hand-rolled for that reason.
 */

import type { CardId, Rank, Suit } from './cards.js';

// ---------------------------------------------------------------------------
// Players & teams
// ---------------------------------------------------------------------------

export type TeamTopology = 'solo' | 'fixed-pairs';

/**
 * Supported table sizes. Many real games accept a range — Callbreak plays
 * 3-6 — so a plugin declares a range rather than a single number, and the
 * engine resolves the concrete deal for whichever count a match is created
 * with. A fixed-size game simply sets `min === max`.
 */
export interface PlayersConfig {
  readonly min: number;
  readonly max: number;
  /** Pre-selected count in the lobby. Must satisfy min <= defaultCount <= max. */
  readonly defaultCount: number;
  readonly topology: TeamTopology;
  /**
   * Required when `topology === 'fixed-pairs'`: seat groupings per table size,
   * keyed by player count. e.g. `{ "4": [[0, 2], [1, 3]] }` for partnerships
   * across the table. Solo games omit this entirely.
   */
  readonly teamsByCount?: Readonly<Record<string, readonly (readonly number[])[]>>;
}

// ---------------------------------------------------------------------------
// Deck
// ---------------------------------------------------------------------------

/**
 * How a deck is distributed for a given table size.
 *
 * - `fixed`     — an exact hand size and kitty, valid only for a fixed-size
 *                 game (players.min === players.max). Used by 29.
 * - `even-split`— deal as evenly as possible and put the remainder in the
 *                 kitty. This is what lets one plugin serve 3, 4, 5 or 6
 *                 players from the same 52-card deck (Callbreak).
 */
export type DealConfig =
  | {
      readonly mode: 'schedule';
      /**
       * Hand size for each hand of the match, indexed by hand number - 1 and
       * wrapping if the match outlasts the list. This is what lets Oh Hell
       * deal 7 cards, then 6, then 5... from one plugin — every other mode
       * assumes the deal shape never changes within a match. Whatever the deck
       * has left over after a hand is dealt becomes the kitty, so a game that
       * turns a card up for trump (`trump.mode: 'kitty-turnup'`) has one.
       */
      readonly handSizes: readonly number[];
    }
  | {
      readonly mode: 'fixed';
      readonly handSize: number;
      readonly kittySize: number;
      /**
       * Staged deal (29): players are dealt this many cards first, bid and
       * select trump on that partial hand, then the rest is dealt once trump
       * is fixed. Omit for a plugin that deals the full hand up front. The
       * engine still deals all `handSize` cards immediately at the RNG layer
       * — this only controls how many of them are *visible* (to the owning
       * player and in `handCount`) before trump selection completes, via
       * `visibleHandCount` below. Keeps `dealHand` a single deterministic
       * shuffle with no separate "second deal" step to keep in sync.
       */
      readonly biddingHandSize?: number;
    }
  | { readonly mode: 'even-split' };

export interface DeckConfig {
  readonly suits: readonly Suit[];
  readonly ranks: readonly Rank[];
  /**
   * Cards removed from the `suits` x `ranks` grid. Most games use a full
   * rectangular deck, but some do not — 3-2-5 plays 30 cards because the Seven
   * exists only in two of the four suits. Without this the deck would have to
   * be either 32 or 24 cards, neither of which is the game.
   */
  readonly excludedCards?: readonly CardId[];
  /** How many cards each player gets, per table size. See `resolveDeal`. */
  readonly deal: DealConfig;
  /**
   * Trick-taking strength order, weakest to strongest. Independent of point
   * value — Callbreak ranks A high with no point weighting; 29 ranks J and 9
   * above A within trump.
   */
  readonly rankOrder: readonly Rank[];
  /** Point value awarded to whoever captures a trick containing this rank (29-style). 0 for pure-trick games like Callbreak/Spades. */
  readonly pointValues: Readonly<Partial<Record<Rank, number>>>;
  /**
   * Point value for every card of a suit, added to the rank value above.
   * Hearts scores one per Heart captured regardless of rank, which no
   * rank-keyed table can express.
   */
  readonly suitPointValues?: Readonly<Partial<Record<Suit, number>>>;
  /**
   * Point value for one specific card. Overrides — does not add to — the rank
   * and suit tables, because the cards that need this are precisely the ones
   * that break their suit's pattern (Hearts' Queen of Spades is worth 13 while
   * every other Spade is worth nothing).
   */
  readonly cardPointValues?: Readonly<Partial<Record<CardId, number>>>;
}

/** What capturing `cardId` is worth, resolving the three point tables' precedence. */
export function cardPointValue(deck: DeckConfig, cardId: string): number {
  const specific = deck.cardPointValues?.[cardId as CardId];
  if (specific !== undefined) return specific;
  const rank = cardId.slice(0, -1) as Rank;
  const suit = cardId.slice(-1) as Suit;
  return (deck.pointValues[rank] ?? 0) + (deck.suitPointValues?.[suit] ?? 0);
}

// ---------------------------------------------------------------------------
// Trump
// ---------------------------------------------------------------------------

export type TrumpMode =
  | 'static'
  | 'bid-selected'
  | 'hidden'
  | 'none'
  | 'declared-by-lead'
  | 'chooser'
  | 'kitty-turnup';

export interface TrumpConfig {
  /**
   * - `static`          — one suit, always (Callbreak: Spades).
   * - `bid-selected`    — the auction winner names it.
   * - `hidden`          — named by the declarer but concealed until revealed (29).
   * - `none`            — the game has no trump at all (Hearts, no-trump Whist).
   *                       Every trick is won by the highest card of the led suit.
   * - `declared-by-lead`— the suit of the first card led in the hand becomes
   *                       trump for that hand (Court Piece).
   * - `chooser`         — a seat fixed by position, not by bidding, names it
   *                       before play (3-2-5). See `chooserDealerOffset`.
   * - `kitty-turnup`    — the first undealt card is turned face up and its suit
   *                       is trump (Oh Hell). Requires a non-empty kitty.
   */
  readonly mode: TrumpMode;
  /** Required when mode === 'static' (Callbreak: always Spades). */
  readonly staticSuit?: Suit;
  /**
   * Required when mode === 'chooser'. Which seat picks trump, counted clockwise
   * from the dealer — 0 is the dealer, 1 the seat to the dealer's left, and
   * `players - 1` the seat to the dealer's right (3-2-5's chooser).
   * Expressed as an offset rather than an absolute seat because the dealer
   * rotates every hand.
   */
  readonly chooserDealerOffset?: number;
  /**
   * Required when mode === 'hidden' (29). The trump suit is fixed by the
   * declarer during bidding but concealed from all players — including, for
   * prompt-construction purposes, the LLM — until a REVEAL_TRUMP action fires.
   */
  readonly hidden?: {
    /** Whether declarer may play the trump-fixing card face down as an ordinary card before revealing. */
    readonly allowConcealedLead: boolean;
  };
}

// ---------------------------------------------------------------------------
// Bidding
// ---------------------------------------------------------------------------

export interface BiddingConfig {
  readonly enabled: boolean;
  readonly minBid: number;
  readonly maxBid: number;
  /** Whether a player may pass instead of bidding. */
  readonly allowPass: boolean;
  /** What the winning bid determines. */
  readonly determines: readonly ('trump-suit' | 'trick-quota')[];
  /**
   * `'single-round'` (default): every seat acts exactly once (bid or pass) and
   * the round ends — Callbreak's simultaneous trick-quota stakes.
   *
   * `'auction'` (29): a pass is permanent, but a seat that hasn't passed may
   * keep being revisited and raise every time the turn comes back around.
   * The auction ends the moment only one un-passed seat remains — which
   * generalizes "three passes in a row end it" for any table size, not just
   * a fixed 4-hander.
   */
  readonly style?: 'single-round' | 'auction';
  /**
   * Auction style only. If every other seat has passed before this seat has
   * placed a single bid, the auction cannot be allowed to end with zero bids
   * on the table (there would be no declarer) — so this seat's only legal
   * actions become bids, never a pass. In 29 this is what forces the dealer's
   * hand when the other three all pass before it's their turn, but the rule
   * is really "the last un-passed bidder can't pass with nothing bid yet",
   * which holds regardless of which seat ends up in that position.
   */
  readonly dealerMustBid?: boolean;
  /**
   * Auction style only. 29's bid-seniority rule: "a player can match a previous
   * bid if they placed it first". A seat that opened the auction earlier than
   * the seat currently holding the high bid may *hold* that number — bid the
   * same value and take the contract back on seniority — rather than being
   * forced one higher. Everyone junior to the holder must still outbid it.
   *
   * Without this flag every bid must strictly exceed the current high bid.
   */
  readonly holdBidBySeniority?: boolean;
  /**
   * `'single-round'` style only. Oh Hell's "hook" (or "screw the dealer") rule:
   * the last seat to bid may not choose the number that would make the bids
   * total exactly the tricks available, guaranteeing at least one seat misses
   * its contract every hand. Withheld from the move list rather than rejected
   * afterwards, so the bounded-choice contract still holds.
   */
  readonly forbidExactTotal?: boolean;
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

export type PhaseKind =
  | 'DEALING'
  | 'BIDDING'
  | 'TRUMP_SELECTION'
  | 'CARD_EXCHANGE'
  | 'PLAYING'
  | 'SCORING';

export interface PhaseDef {
  readonly name: string;
  readonly kind: PhaseKind;
  /** Name of the next phase, or null if this phase ends the hand. */
  readonly next: string | null;
}

/** The `PhaseKind` of a named phase — shared by the move generator and the fog-of-war mask. */
export function phaseKindOf(rules: RulesDsl, phaseName: string): PhaseKind {
  const phase = rules.phases.find((p) => p.name === phaseName);
  if (!phase) throw new Error(`Unknown phase "${phaseName}"`);
  return phase.kind;
}

// ---------------------------------------------------------------------------
// Trick-taking constraints
// ---------------------------------------------------------------------------

export interface TrickRules {
  readonly mustFollowSuit: boolean;
  /** If void in the led suit, must a trump be played when one is held? */
  readonly mustTrumpIfVoid: boolean;
  /**
   * If true, a player who cannot follow suit AND holds no trump has no further
   * restriction (may discard anything). Always true in the games targeted by
   * this PRD; kept explicit so a future variant can override it.
   */
  readonly freeDiscardIfVoidAndNoTrump: boolean;
  /** Some variants require overtrumping when possible; off for all v1 games. */
  readonly mustOvertrumpIfPossible: boolean;
  /**
   * If true, a seat that has just fired a non-atomic REVEAL_TRUMP action (see
   * `CompoundActionRule.atomic`) on its own turn must play a trump card for
   * the follow-up PLAY_CARD if it holds one — independent of `mustTrumpIfVoid`,
   * which governs void-in-lead-suit play generally. Optional: omit (or leave
   * false) for any game that doesn't use a hidden, revealable trump.
   */
  readonly mustTrumpAfterOwnReveal?: boolean;
  /**
   * Suits that may not be *led* until one has already been played off-lead —
   * Hearts' "hearts must be broken before they can be led". A seat holding
   * nothing but locked suits may lead one anyway, since the alternative is
   * having no legal move at all.
   */
  readonly lockedLeadSuits?: readonly Suit[];
}

// ---------------------------------------------------------------------------
// Compound & micro-phase actions (PRD 4.2)
// ---------------------------------------------------------------------------

/**
 * Requirement A: synthesize a combined legal option when conditions hold —
 * e.g. "reveal hidden trump then play this card" as one atomic choice in 29.
 */
export interface CompoundActionRule {
  readonly id: string;
  readonly triggerPhase: string;
  /** Actions fused into a single LegalMove, applied atomically in order. */
  readonly actionSequence: readonly ActionTypeName[];
  /**
   * Every condition must hold (AND) for this rule to fire, evaluated by the
   * engine's rule interpreter (see 4.2). An array rather than a single
   * condition so a game can compose requirements — e.g. "only the declarer,
   * and only once void in the led suit" — without the schema growing a new
   * named condition kind for every combination a game happens to need.
   */
  readonly conditions: readonly CompoundCondition[];
  /**
   * `true` (default when omitted): the actions in `actionSequence` are fused
   * into one indivisible `LegalMove`, as PRD 4.2 Requirement A describes.
   *
   * `false`: only the sequence's first action is offered as its own
   * standalone `LegalMove` when the condition holds. Every later action in
   * the sequence is left to the engine's normal per-turn move generation for
   * that phase, which runs again immediately since firing a non-`PLAY_CARD`
   * action never advances `turnSeat` — so the same seat is asked again,
   * letting a decision-maker (human or LLM) choose the first action, see the
   * resulting state, then choose freely from there rather than committing to
   * both at once. 29 uses this so revealing trump and picking which card to
   * play become two independent decisions instead of one fused choice.
   */
  readonly atomic?: boolean;
}

export type ActionTypeName =
  | 'PLAY_CARD'
  | 'PLACE_BID'
  | 'PASS_BID'
  | 'SELECT_TRUMP'
  | 'REVEAL_TRUMP'
  | 'DISCARD_CARD'
  | 'TAKE_CARD';

export type CompoundCondition =
  | { readonly kind: 'trump-not-yet-revealed' }
  | { readonly kind: 'player-is-declarer' }
  | { readonly kind: 'hand-is-void-in-lead-suit' };

/**
 * Requirement B: a sub-step sequence that pauses the main turn order to
 * collect intermediate decisions before the turn is considered complete —
 * e.g. 3-2-5's "draw one card from talon, then return one card" exchange.
 */
export interface MicroPhaseRule {
  readonly id: string;
  readonly parentPhase: string;
  readonly steps: readonly MicroPhaseStep[];
}

export interface MicroPhaseStep {
  readonly name: string;
  readonly action: ActionTypeName;
  /** How many times this step repeats before advancing (e.g. take 1, return 1). */
  readonly count: number;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Which payout curve a hand is scored with.
 *
 * Deliberately a table of named formulas with parameters, not an expression
 * tree: every real trick-taking game's scoring is one of a handful of shapes
 * with different constants in it, so naming the shapes keeps a plugin author
 * (and the runtime rules.json editor) choosing from a bounded list instead of
 * writing arithmetic that would then need its own evaluator, validator and
 * failure modes.
 *
 * `made` below means whatever `contractBasis` says a competitor captured this
 * hand — card points for `'points'`, tricks for `'tricks'`.
 */
export type ScoringFormula =
  /**
   * Callbreak: make your bid and score it, plus a fraction per overtrick;
   * miss it and lose it outright. Scored per seat.
   */
  | { readonly kind: 'bid-plus-overtrick-fraction'; readonly overtrickValue?: number }
  /**
   * Spades: bid is worth a multiple, overtricks a flat trickle (and feed
   * `bags`), a missed contract costs the multiple. Scored per competitor, so
   * partners' bids combine into one contract.
   */
  | {
      readonly kind: 'bid-multiplier';
      readonly madeMultiplier: number;
      readonly overtrickValue: number;
      readonly missMultiplier: number;
    }
  /**
   * Oh Hell: the bid is exact — taking more than you bid is as bad as taking
   * fewer. Scored per seat.
   */
  | {
      readonly kind: 'exact-bid';
      /** Flat bonus for hitting the bid on the nose. */
      readonly base: number;
      /** Added per trick taken, when the bid was exact. */
      readonly perTrick: number;
      /** Added per trick of error when it was not. Negative to penalise, 0 to merely score nothing. */
      readonly missPerTrick: number;
    }
  /**
   * 3-2-5: score the signed distance from your quota. Beat it by three and you
   * gain three; fall one short and you lose one. Unlike
   * `bid-plus-overtrick-fraction` a miss costs only the shortfall, not the
   * whole contract. Scored per seat.
   */
  | { readonly kind: 'bid-difference' }
  /**
   * Mendicot, Court Piece: the hand is a binary win. Reach the threshold and
   * score a flat amount, fall short and score nothing — the margin above the
   * threshold is irrelevant. Scored per competitor.
   */
  | { readonly kind: 'threshold-win'; readonly threshold: number; readonly value: number }
  /**
   * 29: only the declaring side has a contract.
   */
  | {
      readonly kind: 'declarer-contract';
      /**
       * What the contract is worth. `'bid'` (the default) stakes the bid value
       * itself. A number stakes a flat amount however high the bid was — 29
       * plays for a single game point whether the contract was 16 or 28.
       */
      readonly stake?: number | 'bid';
      /**
       * Whether the defending side takes the opposite result. `'mirror'` (the
       * default) moves both sides; `'unaffected'` moves only the declarer's,
       * which is how 29 is actually scored — a side that never wins an auction
       * never changes its score.
       */
      readonly defenders?: 'mirror' | 'unaffected';
    }
  /**
   * Mendicot, Court Piece, Whist: no contract at all — you simply score what
   * you captured, optionally only the excess over a threshold (Whist scores
   * tricks above six).
   */
  | { readonly kind: 'capture'; readonly threshold?: number }
  /**
   * Hearts: captured points are penalties. Pair with `lowerIsBetter` so the
   * smallest total wins, and with `moonShot` for the capture-everything
   * inversion.
   */
  | { readonly kind: 'penalty-points' };

/**
 * Spades' bag rule: overtricks are worth little on their own but accumulate
 * across hands, and every `per` of them costs `penalty`. This is the one
 * scoring quantity that outlives a hand, which is why it needs its own
 * counter on `GameState` rather than being derivable from the hand just played.
 */
export interface BagRule {
  readonly per: number;
  readonly penalty: number;
}

/** Spades' nil: a seat that bids `bid` contracts to take no tricks at all. */
export interface NilRule {
  /** The bid value that counts as nil. Effectively always 0. */
  readonly bid: number;
  readonly bonus: number;
  readonly penalty: number;
}

/**
 * Hearts' "shooting the moon": one competitor capturing every penalty point in
 * the hand inverts the result instead of taking the worst possible score.
 */
export interface MoonShotRule {
  /**
   * - `'others-take-penalty'` — the shooter scores nothing and everyone else
   *   takes the full hand's penalty.
   * - `'shooter-subtracts'`   — only the shooter is affected, subtracting the
   *   hand's penalty from their own score.
   */
  readonly mode: 'others-take-penalty' | 'shooter-subtracts';
}

export interface ScoringConfig {
  /** Points needed across a match to win outright, if applicable. */
  readonly targetScore?: number;
  /**
   * How many hands make up one match. A match ends when either this many
   * hands have been played or `targetScore` is reached, whichever comes
   * first. Omitting both plays a single hand — the smallest sensible default,
   * and what a plugin that says nothing about match length gets.
   */
  readonly maxHands?: number;
  /** Minimum tricks (or points, per `basis`) the bid-winning side must reach to succeed. */
  readonly contractBasis: 'tricks' | 'points' | 'none';
  /**
   * The payout curve. Omitting it keeps the original per-basis default —
   * `bid-plus-overtrick-fraction` for `'tricks'`, `declarer-contract` for
   * `'points'` — so a plugin written before this field existed scores
   * identically.
   */
  readonly formula?: ScoringFormula;
  /**
   * True when the *lowest* total wins (Hearts). The match still ends when
   * someone reaches `targetScore` — reaching it is what loses you the game
   * rather than what wins it.
   */
  readonly lowerIsBetter?: boolean;
  /** Overtrick accumulator; see `BagRule`. Requires the `bid-multiplier` formula. */
  readonly bags?: BagRule;
  /** Zero-trick side contract; see `NilRule`. */
  readonly nil?: NilRule;
  /** Capture-everything inversion; see `MoonShotRule`. Requires the `penalty-points` formula. */
  readonly moonShot?: MoonShotRule;
  /**
   * Trick quotas assigned by seat position instead of by bidding, indexed
   * clockwise from the dealer (0 = the dealer). This is 3-2-5's whole premise:
   * the dealer owes 2 tricks, the next seat 3 and the next 5, fixed before a
   * card is played. The engine stamps these onto `PlayerState.bid` at deal
   * time, so every downstream contract check treats them as ordinary bids.
   */
  readonly fixedQuotasByDealerOffset?: readonly number[];
}

/** The payout curve `rules` scores with, resolving the per-basis default. */
export function scoringFormula(rules: RulesDsl): ScoringFormula | null {
  if (rules.scoring.formula) return rules.scoring.formula;
  switch (rules.scoring.contractBasis) {
    case 'tricks':
      return { kind: 'bid-plus-overtrick-fraction' };
    case 'points':
      return { kind: 'declarer-contract' };
    case 'none':
      return null;
  }
}

/** Whether `formula` evaluates a bid against what was captured — i.e. whether a result row has a contract to show. */
export function formulaHasContract(formula: ScoringFormula | null): boolean {
  if (formula === null) return false;
  return (
    formula.kind === 'bid-plus-overtrick-fraction' ||
    formula.kind === 'bid-multiplier' ||
    formula.kind === 'exact-bid' ||
    formula.kind === 'bid-difference' ||
    formula.kind === 'declarer-contract'
  );
}

/**
 * Hard ceiling on hands per match, applied when a plugin declares a
 * `targetScore` but no `maxHands`. Stops a game whose scores can stall (or
 * move backwards) from running forever.
 */
export const MAX_HANDS_CEILING = 50;

/**
 * How many hands a match will play at most.
 *
 * `override` is the room host's choice, made when the room is created — match
 * length is the one rule a player is most likely to want to change per sitting
 * ("best of 3 tonight"), and forcing that through a `rules.json` edit would
 * mean editing the game itself to shorten one game of it. Null/undefined falls
 * back to the plugin's own declaration.
 */
export function handLimit(rules: RulesDsl, override?: number | null): number {
  if (override !== undefined && override !== null) return override;
  const { maxHands, targetScore } = rules.scoring;
  if (maxHands !== undefined) return maxHands;
  return targetScore !== undefined ? MAX_HANDS_CEILING : 1;
}

/**
 * The match lengths a host may pick for `rules`, and what the control should
 * start on. Used by the room-creation UI to render the choice and by the
 * server to validate it — same function both sides, so the UI cannot offer a
 * value the server will reject.
 */
export function handLimitBounds(
  rules: RulesDsl,
): { readonly min: number; readonly max: number; readonly defaultValue: number } {
  return { min: 1, max: MAX_HANDS_CEILING, defaultValue: handLimit(rules) };
}

/** Validates a host-supplied match length, returning an error string or null. */
export function validateHandLimit(rules: RulesDsl, override: number): string | null {
  const { min, max } = handLimitBounds(rules);
  if (!Number.isInteger(override)) return 'Number of rounds must be a whole number';
  if (override < min || override > max) return `Number of rounds must be between ${min} and ${max}`;
  return null;
}

// ---------------------------------------------------------------------------
// Root schema
// ---------------------------------------------------------------------------

/**
 * A game's rules, as authored in `rules.json`.
 *
 * Deliberately carries no id. Identity is assigned by the server, not written
 * into the document: a built-in game is identified by its folder under
 * `backend/src/games/`, and an imported one by an id the `PluginRepository`
 * mints on insert. Keeping the id out of the DSL means the same rules.json can
 * be imported twice as two independent games, and that an author can't collide
 * with — or overwrite — someone else's game by choosing the same string.
 */
export interface RulesDsl {
  readonly displayName: string;
  readonly version: string;
  readonly players: PlayersConfig;
  readonly deck: DeckConfig;
  readonly trump: TrumpConfig;
  readonly bidding?: BiddingConfig;
  readonly phases: readonly PhaseDef[];
  readonly trickRules: TrickRules;
  readonly compoundActions?: readonly CompoundActionRule[];
  readonly microPhases?: readonly MicroPhaseRule[];
  readonly scoring: ScoringConfig;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

// ---------------------------------------------------------------------------
// Table-size resolution
// ---------------------------------------------------------------------------

export interface ResolvedDeal {
  readonly handSize: number;
  readonly kittySize: number;
}

export function totalCards(rules: RulesDsl): number {
  return rules.deck.suits.length * rules.deck.ranks.length - (rules.deck.excludedCards?.length ?? 0);
}

/** Every table size this plugin supports, ascending. */
export function supportedPlayerCounts(rules: RulesDsl): number[] {
  const counts: number[] = [];
  for (let n = rules.players.min; n <= rules.players.max; n++) counts.push(n);
  return counts;
}

/**
 * Resolves how many cards each player receives at a given table size.
 * This is the single place table-size-dependent dealing is decided; the
 * engine, the validator and the client all go through it, so a plugin that
 * supports 3-6 players needs no special-casing anywhere.
 */
export function resolveDeal(rules: RulesDsl, playerCount: number, handNumber = 1): ResolvedDeal {
  const total = totalCards(rules);
  const deal = rules.deck.deal;
  if (deal.mode === 'fixed') {
    return { handSize: deal.handSize, kittySize: deal.kittySize };
  }
  if (deal.mode === 'schedule') {
    // Wrapping keeps a match that outruns the schedule dealing something
    // sensible rather than dealing zero cards.
    const handSize = deal.handSizes[(handNumber - 1) % deal.handSizes.length]!;
    return { handSize, kittySize: total - handSize * playerCount };
  }
  const handSize = Math.floor(total / playerCount);
  return { handSize, kittySize: total - handSize * playerCount };
}

/**
 * How many of a player's actually-dealt cards are visible right now. Games
 * with `deck.deal.biddingHandSize` (29) deal the full hand at once internally
 * but keep the back half concealed — even from its own owner — until trump
 * selection resolves, matching the real deal-4/bid/deal-4-more sequence
 * without needing a second dealing step in the engine. Every other plugin
 * gets `actualCount` back unchanged.
 */
export function visibleHandCount(rules: RulesDsl, phaseName: string, actualCount: number): number {
  const cap = rules.deck.deal.mode === 'fixed' ? rules.deck.deal.biddingHandSize : undefined;
  if (cap === undefined) return actualCount;

  const kind = phaseKindOf(rules, phaseName);
  const preReveal = kind === 'DEALING' || kind === 'BIDDING' || kind === 'TRUMP_SELECTION';
  return preReveal ? Math.min(cap, actualCount) : actualCount;
}

/** Seat groupings for a given table size, or null for solo games. */
export function resolveTeams(
  rules: RulesDsl,
  playerCount: number,
): readonly (readonly number[])[] | null {
  if (rules.players.topology !== 'fixed-pairs') return null;
  return rules.players.teamsByCount?.[String(playerCount)] ?? null;
}

/**
 * Structural + cross-field validation for a parsed rules.json. Deliberately
 * hand-rolled (no schema-validation library) so this file stays a dependency
 * of both the backend and the frontend bundle without pulling anything in.
 *
 * PRD 6: plugin loading must "fail fast on invalid JSON DSL" — this is that
 * fast-fail gate, run once at boot per plugin, before the plugin is registered.
 */
export function validateRulesDsl(dsl: unknown): ValidationResult {
  const errors: string[] = [];
  const fail = (msg: string): void => {
    errors.push(msg);
  };

  if (typeof dsl !== 'object' || dsl === null) {
    return { valid: false, errors: ['rules.json must be a JSON object'] };
  }
  const d = dsl as Record<string, unknown>;

  // Rejected rather than ignored. A silently-dropped "gameId" would let an
  // author believe they had named their game and hand them a different id at
  // runtime with no explanation; the error is where that misconception gets
  // corrected. Identity is the server's to assign — see `RulesDsl`.
  if ('gameId' in d) {
    fail('gameId must not appear in rules.json — the id is assigned by the server. Use displayName to name the game');
  }
  if (typeof d.displayName !== 'string' || d.displayName.trim() === '') fail('displayName must be a non-empty string');
  if (typeof d.version !== 'string') fail('version must be a string');

  // players
  const players = d.players as PlayersConfig | undefined;
  let playersValid = false;
  if (!players) {
    fail('players is required');
  } else if (
    typeof players.min !== 'number' ||
    typeof players.max !== 'number' ||
    typeof players.defaultCount !== 'number'
  ) {
    fail('players.min, players.max and players.defaultCount must all be numbers');
  } else if (players.min < 2) {
    fail('players.min must be >= 2');
  } else if (players.max < players.min) {
    fail(`players.max (${players.max}) must be >= players.min (${players.min})`);
  } else if (players.defaultCount < players.min || players.defaultCount > players.max) {
    fail(
      `players.defaultCount (${players.defaultCount}) must be between players.min (${players.min}) and players.max (${players.max})`,
    );
  } else if (!['solo', 'fixed-pairs'].includes(players.topology)) {
    fail('players.topology must be "solo" or "fixed-pairs"');
  } else {
    playersValid = true;
    if (players.topology === 'fixed-pairs') {
      const byCount = players.teamsByCount;
      if (!byCount || typeof byCount !== 'object') {
        fail('players.teamsByCount is required when topology is "fixed-pairs"');
      } else {
        // Every supported table size needs a valid seat partition.
        for (let n = players.min; n <= players.max; n++) {
          const teams = byCount[String(n)];
          if (!Array.isArray(teams) || teams.length < 2) {
            fail(`players.teamsByCount["${n}"] must list >= 2 teams`);
            continue;
          }
          const seats = teams.flat();
          const unique = new Set(seats);
          if (seats.length !== n || unique.size !== n || [...unique].some((s) => s < 0 || s >= n)) {
            fail(`players.teamsByCount["${n}"] must partition seats 0..${n - 1} exactly once`);
          }
        }
      }
    }
  }

  // deck
  const deck = d.deck as DeckConfig | undefined;
  if (!deck) {
    fail('deck is required');
  } else {
    if (!Array.isArray(deck.suits) || deck.suits.length === 0) fail('deck.suits must be a non-empty array');
    if (!Array.isArray(deck.ranks) || deck.ranks.length === 0) fail('deck.ranks must be a non-empty array');
    if (!Array.isArray(deck.rankOrder) || deck.rankOrder.length !== deck.ranks?.length) {
      fail('deck.rankOrder must list every rank in deck.ranks exactly once');
    } else {
      const ranksSet = new Set(deck.ranks);
      const orderSet = new Set(deck.rankOrder);
      if (orderSet.size !== deck.rankOrder.length || [...ranksSet].some((r) => !orderSet.has(r))) {
        fail('deck.rankOrder must be a permutation of deck.ranks with no duplicates');
      }
    }

    if (deck.excludedCards !== undefined) {
      if (!Array.isArray(deck.excludedCards)) {
        fail('deck.excludedCards must be an array when present');
      } else {
        const grid = new Set<string>();
        for (const s of deck.suits ?? []) for (const r of deck.ranks ?? []) grid.add(`${r}${s}`);
        for (const card of deck.excludedCards) {
          if (!grid.has(card)) {
            fail(`deck.excludedCards contains "${card}", which is not in this deck's suits x ranks grid`);
          }
        }
        if (new Set(deck.excludedCards).size !== deck.excludedCards.length) {
          fail('deck.excludedCards must not repeat a card');
        }
      }
    }

    const dealCfg = deck.deal;
    if (!dealCfg || !['fixed', 'even-split', 'schedule'].includes(dealCfg.mode)) {
      fail('deck.deal.mode must be "fixed", "even-split" or "schedule"');
    } else if (dealCfg.mode === 'schedule') {
      if (!Array.isArray(dealCfg.handSizes) || dealCfg.handSizes.length === 0) {
        fail('deck.deal.handSizes must be a non-empty array when mode is "schedule"');
      } else if (dealCfg.handSizes.some((n) => !Number.isInteger(n) || n < 1)) {
        fail('deck.deal.handSizes must contain only positive integers');
      } else if (deck.suits && deck.ranks && players && playersValid) {
        // The largest hand in the schedule has to fit at the largest table.
        const total =
          deck.suits.length * deck.ranks.length - (deck.excludedCards?.length ?? 0);
        const biggest = Math.max(...dealCfg.handSizes);
        if (biggest * players.max > total) {
          fail(
            `deck.deal.handSizes has a hand of ${biggest}, which needs ${biggest * players.max} cards at ${players.max} players but the deck holds only ${total}`,
          );
        }
      }
    } else if (dealCfg.mode === 'fixed') {
      if (typeof dealCfg.handSize !== 'number' || dealCfg.handSize <= 0) {
        fail('deck.deal.handSize must be a positive number when mode is "fixed"');
      }
      if (typeof dealCfg.kittySize !== 'number' || dealCfg.kittySize < 0) {
        fail('deck.deal.kittySize must be >= 0 when mode is "fixed"');
      }
      if (players && playersValid && players.min !== players.max) {
        fail(
          `deck.deal.mode "fixed" requires a fixed table size, but players.min (${players.min}) !== players.max (${players.max}). Use "even-split" for a variable-size game.`,
        );
      }
      if (dealCfg.biddingHandSize !== undefined) {
        if (typeof dealCfg.biddingHandSize !== 'number' || dealCfg.biddingHandSize <= 0) {
          fail('deck.deal.biddingHandSize must be a positive number when present');
        } else if (typeof dealCfg.handSize === 'number' && dealCfg.biddingHandSize >= dealCfg.handSize) {
          fail(
            `deck.deal.biddingHandSize (${dealCfg.biddingHandSize}) must be less than deck.deal.handSize (${dealCfg.handSize})`,
          );
        }
      }
      // Exact deck accounting for the single supported table size.
      if (deck.suits && deck.ranks && players && playersValid && typeof dealCfg.handSize === 'number') {
        const excluded = deck.excludedCards?.length ?? 0;
        const total = deck.suits.length * deck.ranks.length - excluded;
        const required = dealCfg.handSize * players.min + (dealCfg.kittySize ?? 0);
        if (total !== required) {
          fail(
            `deck size mismatch: ${deck.suits.length} suits * ${deck.ranks.length} ranks - ${excluded} excluded = ${total} cards, ` +
              `but handSize(${dealCfg.handSize}) * players(${players.min}) + kittySize(${dealCfg.kittySize}) = ${required}`,
          );
        }
      }
    } else if (dealCfg.mode === 'even-split' && deck.suits && deck.ranks && players && playersValid) {
      // even-split: every supported table size must leave each player a hand.
      const total = deck.suits.length * deck.ranks.length - (deck.excludedCards?.length ?? 0);
      for (let n = players.min; n <= players.max; n++) {
        if (Math.floor(total / n) < 1) {
          fail(`deck has only ${total} cards — not enough to deal to ${n} players`);
        }
      }
    }

    if (deck.pointValues && typeof deck.pointValues !== 'object') fail('deck.pointValues must be an object');
  }

  // trump
  const TRUMP_MODES: readonly string[] = [
    'static',
    'bid-selected',
    'hidden',
    'none',
    'declared-by-lead',
    'chooser',
    'kitty-turnup',
  ];
  const trump = d.trump as TrumpConfig | undefined;
  if (!trump || !TRUMP_MODES.includes(trump.mode)) {
    fail(`trump.mode must be one of ${TRUMP_MODES.map((m) => `"${m}"`).join(', ')}`);
  } else {
    if (trump.mode === 'static' && !trump.staticSuit) fail('trump.staticSuit is required when trump.mode is "static"');
    if (trump.mode === 'hidden' && !trump.hidden) fail('trump.hidden config is required when trump.mode is "hidden"');
    if (trump.mode === 'chooser') {
      const offset = trump.chooserDealerOffset;
      if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
        fail('trump.chooserDealerOffset must be a non-negative integer when trump.mode is "chooser"');
      } else if (players && playersValid && offset >= players.min) {
        fail(
          `trump.chooserDealerOffset (${offset}) must be less than players.min (${players.min}) so the chooser exists at every table size`,
        );
      }
    }
    // A turned-up trump needs a card to turn up. `fixed` states its kitty
    // outright; the other modes only leave one when the deck does not divide
    // evenly, which is a property of the deal, not something declared here.
    if (trump.mode === 'kitty-turnup' && deck?.deal?.mode === 'fixed' && !(deck.deal.kittySize > 0)) {
      fail('trump.mode "kitty-turnup" requires deck.deal.kittySize > 0 — there is no card to turn up');
    }
  }

  // bidding
  const bidding = d.bidding as BiddingConfig | undefined;
  if (bidding) {
    if (typeof bidding.minBid !== 'number' || typeof bidding.maxBid !== 'number' || bidding.minBid > bidding.maxBid) {
      fail('bidding.minBid must be <= bidding.maxBid');
    }
    if (!Array.isArray(bidding.determines) || bidding.determines.length === 0) {
      fail('bidding.determines must be a non-empty array');
    }
    if (bidding.style !== undefined && !['single-round', 'auction'].includes(bidding.style)) {
      fail('bidding.style must be "single-round" or "auction" when present');
    }
    if (bidding.dealerMustBid && bidding.style !== 'auction') {
      fail('bidding.dealerMustBid only applies when bidding.style is "auction"');
    }
    if (bidding.holdBidBySeniority && bidding.style !== 'auction') {
      fail('bidding.holdBidBySeniority only applies when bidding.style is "auction"');
    }
    if (bidding.forbidExactTotal && bidding.style === 'auction') {
      fail('bidding.forbidExactTotal applies to "single-round" bidding, not an auction');
    }
  }
  if (trump?.mode === 'bid-selected' && (!bidding || !bidding.determines?.includes('trump-suit'))) {
    fail('trump.mode "bid-selected" requires bidding.determines to include "trump-suit"');
  }
  if (trump?.mode === 'none' && bidding?.determines?.includes('trump-suit')) {
    fail('trump.mode "none" cannot be combined with bidding.determines "trump-suit" — there is no trump to select');
  }

  // phases
  const phases = d.phases as PhaseDef[] | undefined;
  if (!Array.isArray(phases) || phases.length === 0) {
    fail('phases must be a non-empty array');
  } else {
    const names = new Set(phases.map((p) => p.name));
    if (names.size !== phases.length) fail('phases[].name must be unique');
    for (const p of phases) {
      if (p.next !== null && !names.has(p.next)) {
        fail(`phase "${p.name}" transitions to unknown phase "${p.next}"`);
      }
    }
    const terminal = phases.filter((p) => p.next === null);
    if (terminal.length === 0) fail('at least one phase must have next: null to end the hand');
  }

  // trick rules
  const trickRules = d.trickRules as TrickRules | undefined;
  if (!trickRules || typeof trickRules.mustFollowSuit !== 'boolean') {
    fail('trickRules.mustFollowSuit must be a boolean');
  } else {
    if (
      trickRules.mustTrumpAfterOwnReveal !== undefined &&
      typeof trickRules.mustTrumpAfterOwnReveal !== 'boolean'
    ) {
      fail('trickRules.mustTrumpAfterOwnReveal must be a boolean when present');
    }
    if (trickRules.lockedLeadSuits !== undefined) {
      if (!Array.isArray(trickRules.lockedLeadSuits)) {
        fail('trickRules.lockedLeadSuits must be an array when present');
      } else {
        for (const suit of trickRules.lockedLeadSuits) {
          if (!deck?.suits?.includes(suit)) {
            fail(`trickRules.lockedLeadSuits contains "${suit}", which is not in deck.suits`);
          }
        }
      }
    }
  }

  // scoring
  const scoring = d.scoring as ScoringConfig | undefined;
  if (!scoring || !['tricks', 'points', 'none'].includes(scoring.contractBasis)) {
    fail('scoring.contractBasis must be one of "tricks", "points", "none"');
  } else {
    if (scoring.maxHands !== undefined && (!Number.isInteger(scoring.maxHands) || scoring.maxHands < 1)) {
      fail('scoring.maxHands must be a positive integer when present');
    }
    if (scoring.maxHands !== undefined && scoring.maxHands > MAX_HANDS_CEILING) {
      fail(`scoring.maxHands must be <= ${MAX_HANDS_CEILING}`);
    }
    if (scoring.targetScore !== undefined && typeof scoring.targetScore !== 'number') {
      fail('scoring.targetScore must be a number when present');
    }

    const FORMULA_KINDS: readonly string[] = [
      'bid-plus-overtrick-fraction',
      'bid-multiplier',
      'exact-bid',
      'bid-difference',
      'threshold-win',
      'declarer-contract',
      'capture',
      'penalty-points',
    ];
    const formula = scoring.formula;
    if (formula !== undefined) {
      if (typeof formula !== 'object' || formula === null || !FORMULA_KINDS.includes(formula.kind)) {
        fail(`scoring.formula.kind must be one of ${FORMULA_KINDS.map((k) => `"${k}"`).join(', ')}`);
      } else if (formula.kind === 'bid-multiplier') {
        const nums = [formula.madeMultiplier, formula.overtrickValue, formula.missMultiplier];
        if (nums.some((n) => typeof n !== 'number')) {
          fail('scoring.formula "bid-multiplier" requires numeric madeMultiplier, overtrickValue and missMultiplier');
        }
      } else if (formula.kind === 'exact-bid') {
        const nums = [formula.base, formula.perTrick, formula.missPerTrick];
        if (nums.some((n) => typeof n !== 'number')) {
          fail('scoring.formula "exact-bid" requires numeric base, perTrick and missPerTrick');
        }
      } else if (formula.kind === 'capture' && formula.threshold !== undefined && typeof formula.threshold !== 'number') {
        fail('scoring.formula "capture" requires threshold to be a number when present');
      } else if (formula.kind === 'threshold-win') {
        if (typeof formula.threshold !== 'number' || typeof formula.value !== 'number') {
          fail('scoring.formula "threshold-win" requires numeric threshold and value');
        }
      } else if (formula.kind === 'declarer-contract') {
        if (formula.stake !== undefined && formula.stake !== 'bid' && typeof formula.stake !== 'number') {
          fail('scoring.formula "declarer-contract" requires stake to be a number or "bid" when present');
        }
        if (formula.defenders !== undefined && !['mirror', 'unaffected'].includes(formula.defenders)) {
          fail('scoring.formula "declarer-contract" requires defenders to be "mirror" or "unaffected" when present');
        }
      }
    }

    // A formula that reads a bid needs the game to produce one — either from
    // bidding or from fixed quotas. Catching this here turns a plugin that
    // would silently score every hand as a missed contract into a load error.
    const producesBids = Boolean(bidding?.enabled) || Array.isArray(scoring.fixedQuotasByDealerOffset);
    if (formula && formulaHasContract(formula) && formula.kind !== 'declarer-contract' && !producesBids) {
      fail(
        `scoring.formula "${formula.kind}" scores a bid against what was captured, but this game has neither bidding.enabled nor scoring.fixedQuotasByDealerOffset`,
      );
    }

    if (scoring.bags !== undefined) {
      const { per, penalty } = scoring.bags;
      if (!Number.isInteger(per) || per < 1 || typeof penalty !== 'number') {
        fail('scoring.bags requires an integer per >= 1 and a numeric penalty');
      }
      if (formula?.kind !== 'bid-multiplier') {
        fail('scoring.bags only applies to the "bid-multiplier" formula, which is what produces bags');
      }
    }

    if (scoring.nil !== undefined) {
      const { bid, bonus, penalty } = scoring.nil;
      if (typeof bid !== 'number' || typeof bonus !== 'number' || typeof penalty !== 'number') {
        fail('scoring.nil requires numeric bid, bonus and penalty');
      } else if (bidding && bid < bidding.minBid) {
        fail(`scoring.nil.bid (${bid}) is below bidding.minBid (${bidding.minBid}), so it can never be bid`);
      }
    }

    if (scoring.moonShot !== undefined) {
      if (!['others-take-penalty', 'shooter-subtracts'].includes(scoring.moonShot.mode)) {
        fail('scoring.moonShot.mode must be "others-take-penalty" or "shooter-subtracts"');
      }
      if (formula?.kind !== 'penalty-points') {
        fail('scoring.moonShot only applies to the "penalty-points" formula');
      }
    }

    const quotas = scoring.fixedQuotasByDealerOffset;
    if (quotas !== undefined) {
      if (!Array.isArray(quotas) || quotas.some((q) => !Number.isInteger(q) || q < 0)) {
        fail('scoring.fixedQuotasByDealerOffset must be an array of non-negative integers');
      } else if (players && playersValid && quotas.length !== players.min) {
        // One quota per seat, so a variable-size table cannot use them.
        fail(
          `scoring.fixedQuotasByDealerOffset has ${quotas.length} entries but the table seats ${players.min}${players.min === players.max ? '' : `-${players.max}`} — it needs exactly one quota per seat`,
        );
      }
      if (bidding?.enabled) {
        fail('scoring.fixedQuotasByDealerOffset assigns quotas without bidding, so bidding.enabled must be false');
      }
    }

    if (scoring.lowerIsBetter !== undefined && typeof scoring.lowerIsBetter !== 'boolean') {
      fail('scoring.lowerIsBetter must be a boolean when present');
    }
  }

  // compound actions reference known phases
  const compoundActions = d.compoundActions as CompoundActionRule[] | undefined;
  if (compoundActions) {
    const phaseNames = new Set((phases ?? []).map((p) => p.name));
    for (const c of compoundActions) {
      if (!phaseNames.has(c.triggerPhase)) {
        fail(`compoundActions["${c.id}"] references unknown phase "${c.triggerPhase}"`);
      }
      if (!Array.isArray(c.actionSequence) || c.actionSequence.length < 2) {
        fail(`compoundActions["${c.id}"].actionSequence must contain at least 2 actions`);
      }
      if (!Array.isArray(c.conditions) || c.conditions.length === 0) {
        fail(`compoundActions["${c.id}"].conditions must be a non-empty array`);
      }
      if (c.atomic !== undefined && typeof c.atomic !== 'boolean') {
        fail(`compoundActions["${c.id}"].atomic must be a boolean when present`);
      }
    }
  }

  // micro-phases reference known phases
  const microPhases = d.microPhases as MicroPhaseRule[] | undefined;
  if (microPhases) {
    const phaseNames = new Set((phases ?? []).map((p) => p.name));
    for (const m of microPhases) {
      if (!phaseNames.has(m.parentPhase)) {
        fail(`microPhases["${m.id}"] references unknown phase "${m.parentPhase}"`);
      }
      if (!Array.isArray(m.steps) || m.steps.length === 0) {
        fail(`microPhases["${m.id}"].steps must be a non-empty array`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
