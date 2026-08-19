/**
 * Canonical card vocabulary shared by the engine, the AI layer and the client.
 *
 * A card is identified by a compact string (`"AS"`, `"TH"`, `"7D"`) so that it
 * survives JSON round-trips, is cheap to compare, and reads naturally inside an
 * LLM prompt. Ten is `"T"` so every card id is exactly two characters.
 */

export const SUITS = ['S', 'H', 'D', 'C'] as const;
export type Suit = (typeof SUITS)[number];

export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const;
export type Rank = (typeof RANKS)[number];

export type CardId = `${Rank}${Suit}`;

export interface Card {
  readonly id: CardId;
  readonly rank: Rank;
  readonly suit: Suit;
}

export const SUIT_NAMES: Readonly<Record<Suit, string>> = {
  S: 'Spades',
  H: 'Hearts',
  D: 'Diamonds',
  C: 'Clubs',
};

export const RANK_NAMES: Readonly<Record<Rank, string>> = {
  '2': 'Two',
  '3': 'Three',
  '4': 'Four',
  '5': 'Five',
  '6': 'Six',
  '7': 'Seven',
  '8': 'Eight',
  '9': 'Nine',
  T: 'Ten',
  J: 'Jack',
  Q: 'Queen',
  K: 'King',
  A: 'Ace',
};

export function makeCard(rank: Rank, suit: Suit): Card {
  return { id: `${rank}${suit}`, rank, suit };
}

export function parseCard(id: string): Card {
  const rank = id.slice(0, -1) as Rank;
  const suit = id.slice(-1) as Suit;
  if (!RANKS.includes(rank)) throw new Error(`Invalid rank in card id "${id}"`);
  if (!SUITS.includes(suit)) throw new Error(`Invalid suit in card id "${id}"`);
  return { id: id as CardId, rank, suit };
}

export function isCardId(value: string): value is CardId {
  if (value.length < 2) return false;
  return (
    RANKS.includes(value.slice(0, -1) as Rank) && SUITS.includes(value.slice(-1) as Suit)
  );
}

/** Human-readable form used in LLM prompts and logs, e.g. `"Ace of Spades"`. */
export function describeCard(id: CardId): string {
  const { rank, suit } = parseCard(id);
  return `${RANK_NAMES[rank]} of ${SUIT_NAMES[suit]}`;
}

/**
 * Placeholder used by the fog-of-war layer wherever a real card exists but the
 * viewer is not entitled to see it. Never appears in authoritative state.
 */
export const HIDDEN_CARD = 'HIDDEN' as const;
export type HiddenCard = typeof HIDDEN_CARD;

/** A card slot as seen by a specific viewer: either a real card or a mask. */
export type MaskedCard = CardId | HiddenCard;

/** Marker for concealed non-card state, e.g. an unrevealed trump suit in 29. */
export const HIDDEN_STATUS = 'STATUS: HIDDEN' as const;
export type HiddenStatus = typeof HIDDEN_STATUS;
