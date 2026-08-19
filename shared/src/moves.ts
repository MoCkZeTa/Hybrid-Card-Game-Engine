/**
 * Move vocabulary.
 *
 * The engine never asks a decision-maker "what do you want to do?" — it emits a
 * bounded array of `LegalMove`s and asks it to pick one by `id`. This is the
 * mechanism behind the PRD's zero-hallucination guarantee: an LLM can only ever
 * point at an option the deterministic layer already validated.
 *
 * A `LegalMove` carries one or more `EngineAction`s. More than one means an
 * atomic compound move (PRD 4.2 Requirement A) — for example revealing the
 * hidden trump in 29 and playing a card as a single indivisible choice.
 */

import type { CardId, Suit } from './cards.js';

export type ActionType =
  | 'PLAY_CARD'
  | 'PLACE_BID'
  | 'PASS_BID'
  | 'SELECT_TRUMP'
  | 'REVEAL_TRUMP'
  | 'DISCARD_CARD'
  | 'TAKE_CARD';

export interface PlayCardAction {
  readonly type: 'PLAY_CARD';
  readonly card: CardId;
}

export interface PlaceBidAction {
  readonly type: 'PLACE_BID';
  readonly value: number;
}

export interface PassBidAction {
  readonly type: 'PASS_BID';
}

export interface SelectTrumpAction {
  readonly type: 'SELECT_TRUMP';
  readonly suit: Suit;
  /** When true the suit is recorded but withheld from other players (29). */
  readonly concealed: boolean;
}

export interface RevealTrumpAction {
  readonly type: 'REVEAL_TRUMP';
}

export interface DiscardCardAction {
  readonly type: 'DISCARD_CARD';
  readonly card: CardId;
}

export interface TakeCardAction {
  readonly type: 'TAKE_CARD';
  readonly card: CardId;
}

export type EngineAction =
  | PlayCardAction
  | PlaceBidAction
  | PassBidAction
  | SelectTrumpAction
  | RevealTrumpAction
  | DiscardCardAction
  | TakeCardAction;

/**
 * One selectable option. `id` is stable within a single decision point only —
 * it is the token the AI returns, and the token the client sends back.
 */
export interface LegalMove {
  readonly id: string;
  /** Ordered actions applied atomically, in array order. */
  readonly actions: readonly EngineAction[];
  /** Short natural-language description injected into the LLM prompt. */
  readonly label: string;
  /** Optional engine-side hints (e.g. `"risky"`) surfaced to the UI. */
  readonly tags?: readonly string[];
}

/** Result of a decision, whoever made it. */
export interface Decision {
  readonly moveId: string;
  /**
   * 'forced' — only one legal move existed, so no decision-maker was invoked.
   * 'fallback' — a decision-maker was invoked but timed out, errored, or
   * returned an invalid moveId, so legal_moves[0] was played instead (PRD 6).
   */
  readonly source: 'human' | 'llm' | 'fallback' | 'forced';
  /** Free-text rationale from the LLM, for logs and the UI. Never trusted. */
  readonly reasoning?: string;
  readonly latencyMs?: number;
}
