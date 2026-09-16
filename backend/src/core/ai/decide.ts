/**
 * The AI decision orchestrator — where PRD section 6's latency SLA and
 * fallback rules actually get enforced. Everything upstream (engine, fog of
 * war, prompt compiler, provider) is pure/inert; this is the one place that
 * owns the clock and decides when to give up on the LLM and fall back.
 */

import type { Decision, GameState, RulesDsl, SeatIndex } from '@hcg/shared';
import type { GamePlugin } from '../plugin/plugin-manager.js';
import { maskGameState } from '../obfuscation/fog-of-war.js';
import { compilePrompt } from './prompt.js';
import type { LLMProvider } from './provider.js';

export interface DecideTurnOptions {
  readonly rules: RulesDsl;
  readonly plugin: GamePlugin;
  readonly state: GameState;
  readonly seat: SeatIndex;
  readonly provider: LLMProvider;
  /** PRD 6: LLM Inference Request budget. Default 1200ms. */
  readonly llmTimeoutMs?: number;
  /**
   * Fraction of the hand's completed tricks this seat's bot is shown, 0..1.
   * Default 1 (full history). Travels from `BotTier` alongside `llmTimeoutMs`
   * because both are difficulty settings and both apply here — one bounds how
   * long the model may think, the other how much of the hand it remembers.
   */
  readonly memoryFraction?: number;
}

/**
 * Decides seat `seat`'s move for the current turn. Always returns a valid
 * `moveId` from that seat's legal moves — never throws for a timeout,
 * provider error, or malformed LLM response; those all degrade to the
 * deterministic `legal_moves[0]` fallback (PRD 6, Fallback Execution Rule 3)
 * so the game loop can never stall on a flaky external API call.
 */
export async function decideTurn(opts: DecideTurnOptions): Promise<Decision> {
  const { rules, plugin, state, seat, provider, llmTimeoutMs = 1200, memoryFraction } = opts;

  if (state.turnSeat !== seat) {
    throw new Error(`decideTurn called for seat ${seat} but it is seat ${state.turnSeat}'s turn`);
  }

  const masked = maskGameState(rules, state, seat);
  if (masked.legalMoves.length === 0) {
    throw new Error(`No legal moves available for seat ${seat} in phase "${state.phase}"`);
  }
  if (masked.legalMoves.length === 1) {
    // No real decision to make — skip the LLM call entirely (saves latency and cost).
    return { moveId: masked.legalMoves[0]!.id, source: 'forced' };
  }

  const legalIds = new Set(masked.legalMoves.map((m) => m.id));
  const fallbackId = masked.legalMoves[0]!.id;
  const { systemPrompt, userPrompt } = compilePrompt(plugin, masked, { memoryFraction });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), llmTimeoutMs);
  const startedAt = Date.now();

  try {
    const response = await provider.decide({
      systemPrompt,
      userPrompt,
      legalMoveIds: [...legalIds],
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;

    if (!legalIds.has(response.moveId)) {
      // PRD 5.2: an identifier outside the choice set MUST be rejected.
      return {
        moveId: fallbackId,
        source: 'fallback',
        reasoning: `Rejected invalid moveId "${response.moveId}" from ${provider.name}; played legal_moves[0] instead.`,
        latencyMs,
      };
    }

    return { moveId: response.moveId, source: 'llm', reasoning: response.reasoning, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    return {
      moveId: fallbackId,
      source: 'fallback',
      reasoning: `${provider.name} call failed or timed out (${(err as Error).message}); played legal_moves[0] instead.`,
      latencyMs,
    };
  } finally {
    clearTimeout(timer);
  }
}
