/**
 * Deck construction, shuffling and dealing — driven entirely by `rules.json`
 * (deck.suits / deck.ranks / deck.handSize / deck.kittySize). No game-specific
 * code exists here; a new plugin with a different suit/rank/hand-size
 * combination works automatically as long as `validateRulesDsl` accepted it.
 */

import type { CardId, RulesDsl } from '@hcg/shared';
import { makeCard, resolveDeal } from '@hcg/shared';

/** A seedable PRNG so dealing is reproducible in tests without touching global state. */
export type Rng = () => number;

/** Mulberry32 — small, fast, good enough for card shuffling (not cryptographic). */
export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildDeck(rules: RulesDsl): CardId[] {
  const excluded = new Set<string>(rules.deck.excludedCards ?? []);
  const deck: CardId[] = [];
  for (const suit of rules.deck.suits) {
    for (const rank of rules.deck.ranks) {
      const { id } = makeCard(rank, suit);
      if (!excluded.has(id)) deck.push(id);
    }
  }
  return deck;
}

export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}

export interface DealResult {
  readonly hands: readonly (readonly CardId[])[];
  readonly kitty: readonly CardId[];
}

/**
 * Deals a freshly shuffled deck for a specific table size. Hand/kitty sizes
 * come from `resolveDeal`, so a plugin declaring `even-split` deals correctly
 * at 3, 4, 5 or 6 players with no game-specific code here.
 */
export function deal(rules: RulesDsl, playerCount: number, rng: Rng, handNumber = 1): DealResult {
  const { handSize, kittySize } = resolveDeal(rules, playerCount, handNumber);
  const shuffled = shuffle(buildDeck(rules), rng);
  const hands: CardId[][] = Array.from({ length: playerCount }, () => []);

  let cursor = 0;
  for (let seat = 0; seat < playerCount; seat++) {
    hands[seat] = shuffled.slice(cursor, cursor + handSize);
    cursor += handSize;
  }
  const kitty = shuffled.slice(cursor, cursor + kittySize);

  return { hands, kitty };
}
