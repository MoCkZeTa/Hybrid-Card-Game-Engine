/**
 * Prompt compiler (PRD 3.2, 5.1): merges a game plugin's `strategy.md` with
 * the current fog-of-war-masked state and the bounded choice set into a
 * system/user prompt pair. This is the only place `strategy.md` content ever
 * touches an LLM call.
 */

import type { MaskedGameState } from '@hcg/shared';
import type { GamePlugin } from '../plugin/plugin-manager.js';

export interface CompiledPrompt {
  readonly systemPrompt: string;
  readonly userPrompt: string;
}

const OUTPUT_CONTRACT = `
You are the decision-making AI for a card game player. You will be given:
- Strategic guidance for this specific game.
- The current visible game state (your own hand, the table, scores). Anything
  you cannot legitimately know has already been withheld or masked — do not
  assume hidden information.
- The tricks completed so far this hand, possibly only the most recent ones.
  The "completedTricksShown" and "completedTricksPlayed" counts tell you how
  much of the hand you can actually see. When they differ, tricks were played
  that you are not being shown: never conclude that a card is still live
  merely because you have not seen it fall.
- A numbered list of legal moves. This list is exhaustive and authoritative:
  every option in it is guaranteed valid, and nothing outside it is valid.

Respond with ONLY a single JSON object, no markdown fences, no extra text:
  { "moveId": "<one id from the legal moves list>", "reasoning": "<short rationale>" }

The "moveId" field MUST exactly match one "id" from the legal moves list.
`.trim();

export interface PromptOptions {
  /**
   * Fraction of this hand's completed tricks to show, 0..1. Defaults to 1 —
   * the full history — so any caller that doesn't care gets everything the
   * viewer is entitled to. `MatchManager` passes the bot's difficulty level
   * here (`BotTier.memoryFraction`).
   *
   * Below 1 the prompt still reports how many tricks it is *withholding*.
   * Partial history presented as complete is worse than no history at all: a
   * model that believes it has seen every trick will confidently play into a
   * card that fell three tricks ago, whereas one that knows it is missing
   * tricks hedges instead.
   */
  readonly memoryFraction?: number;
}

export function compilePrompt(
  plugin: GamePlugin,
  masked: MaskedGameState,
  options: PromptOptions = {},
): CompiledPrompt {
  const systemPrompt = `${OUTPUT_CONTRACT}\n\n---\n\nGame: ${plugin.rules.displayName}\n\n${plugin.strategy}`;

  const viewer = masked.players.find((p) => p.seat === masked.viewerSeat);

  const played = masked.completedTricks.length;
  const fraction = Math.min(1, Math.max(0, options.memoryFraction ?? 1));
  const keep = Math.ceil(fraction * played);
  // Keep the most *recent* tricks — forgetting works backwards, so a
  // limited-memory bot loses the opening of the hand first, the way an
  // inattentive player does. Guarded because `slice(-0)` is `slice(0)`, which
  // would hand a zero-memory bot the entire history.
  const shownTricks = keep === 0 ? [] : masked.completedTricks.slice(-keep);

  const userPrompt = JSON.stringify(
    {
      phase: masked.phase,
      yourSeat: masked.viewerSeat,
      yourHand: viewer?.hand ?? [],
      dealerSeat: masked.dealerSeat,
      declarerSeat: masked.declarerSeat,
      trumpSuit: masked.trumpSuit,
      trumpRevealed: masked.trumpRevealed,
      leadSuit: masked.leadSuit,
      currentTrick: masked.currentTrick,
      completedTricksPlayed: played,
      completedTricksShown: shownTricks.length,
      // Deliberately compact ("0:AS" rather than a nested object): this is the
      // one field that grows through the hand, and it rides on every turn's
      // prompt against a per-level latency budget. Pretty-printed nested
      // objects here roughly triple the cost for no gain in legibility.
      completedTricks: shownTricks.map((t) => ({
        led: t.leadSuit,
        wonBy: t.winnerSeat,
        cards: t.cards.map((c) => `${c.seat}:${c.card}`),
      })),
      players: masked.players.map((p) => ({
        seat: p.seat,
        teamKey: p.teamKey,
        handCount: p.handCount,
        tricksWon: p.tricksWon,
        bid: p.bid,
      })),
      scoringBasis: masked.scoringBasis,
      teamScores: masked.teamScores,
      handPointsThisHand: masked.handPoints,
      handNumber: masked.handNumber,
      legalMoves: masked.legalMoves.map((m) => ({ id: m.id, label: m.label, tags: m.tags ?? [] })),
    },
    null,
    2,
  );

  return { systemPrompt, userPrompt };
}
