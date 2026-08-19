/**
 * Card-strength comparison and trick resolution. Both are pure functions of
 * `rules.deck.rankOrder` / `rules.trump`, so a hidden-trump game (29) and a
 * static-trump game (Callbreak) share this exact code path.
 */

import type { CardId, RulesDsl, Suit, SeatIndex, TrickCard } from '@hcg/shared';
import { cardPointValue, parseCard } from '@hcg/shared';

/** Index of a rank's trick-taking strength, weakest = 0. Throws on an unknown rank — a config bug, not a runtime case. */
function rankStrength(rules: RulesDsl, cardId: CardId): number {
  const { rank } = parseCard(cardId);
  const idx = rules.deck.rankOrder.indexOf(rank);
  if (idx === -1) {
    throw new Error(`Rank "${rank}" (from card "${cardId}") is not present in deck.rankOrder`);
  }
  return idx;
}

/**
 * Compares two cards *within the context of a resolved trick* — i.e. once we
 * know the lead suit and (if applicable) the trump suit. A card outside both
 * suits never wins regardless of rank, matching standard follow-suit rules.
 */
function trickValue(rules: RulesDsl, cardId: CardId, leadSuit: Suit, trumpSuit: Suit | null): number {
  const { suit } = parseCard(cardId);
  const strength = rankStrength(rules, cardId);
  if (trumpSuit !== null && suit === trumpSuit) return 1000 + strength; // trump always beats non-trump
  if (suit === leadSuit) return strength;
  return -1; // off-suit, non-trump: cannot win
}

/** 
 * Determines which seat wins a completed trick.
 *
 * `trumpSuit` must be `null` whenever trump has not yet been revealed (29) —
 * callers must not pass the concealed suit through early, or trump-beats-lead
 * logic would apply before the game state says it's allowed to.
 */
export function resolveTrick(
  rules: RulesDsl,
  trick: readonly TrickCard[],
  leadSuit: Suit,
  trumpSuit: Suit | null,
): SeatIndex {
  if (trick.length === 0) throw new Error('Cannot resolve an empty trick');

  let winner = trick[0]!;
  let bestValue = trickValue(rules, winner.card, leadSuit, trumpSuit);

  for (const entry of trick.slice(1)) {
    const value = trickValue(rules, entry.card, leadSuit, trumpSuit);
    if (value > bestValue) {
      bestValue = value;
      winner = entry;
    }
  }
  return winner.seat;
}

/**
 * What capturing this trick is worth, summing the deck's rank/suit/card point
 * tables. 0 for pure trick-count games like Callbreak; a penalty total for a
 * game whose point values represent damage (Hearts).
 */
export function trickPointValue(rules: RulesDsl, trick: readonly TrickCard[]): number {
  return trick.reduce((sum, entry) => sum + cardPointValue(rules.deck, entry.card), 0);
}

/** Every point available in one hand — the denominator for detecting a moon shot. */
export function totalPointsInDeck(rules: RulesDsl, deck: readonly CardId[]): number {
  return deck.reduce((sum, card) => sum + cardPointValue(rules.deck, card), 0);
}
