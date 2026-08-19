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
- A numbered list of legal moves. This list is exhaustive and authoritative:
  every option in it is guaranteed valid, and nothing outside it is valid.

Respond with ONLY a single JSON object, no markdown fences, no extra text:
  { "moveId": "<one id from the legal moves list>", "reasoning": "<short rationale>" }

The "moveId" field MUST exactly match one "id" from the legal moves list.
`.trim();

export function compilePrompt(plugin: GamePlugin, masked: MaskedGameState): CompiledPrompt {
  const systemPrompt = `${OUTPUT_CONTRACT}\n\n---\n\nGame: ${plugin.rules.displayName}\n\n${plugin.strategy}`;

  const viewer = masked.players.find((p) => p.seat === masked.viewerSeat);

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
