/**
 * Fog-of-war projection (PRD 4.1). This is the single choke point through
 * which authoritative `GameState` becomes visible to anyone outside the
 * process — a client over the WebSocket, or the AI pipeline building an LLM
 * prompt. Neither of those callers may ever see the raw `GameState`; both
 * must go through `maskGameState`.
 *
 * Masking rules:
 *  - Every seat's hand is visible only to that seat itself.
 *  - The trump suit is `"STATUS: HIDDEN"` until revealed, UNLESS the viewer
 *    is the declarer (who fixed it and therefore already knows it).
 *  - The kitty's contents are never exposed, only its count.
 *  - `legalMoves` is populated only for the viewer whose turn it currently is
 *    — everyone else gets an empty array, so idle seats can't probe for
 *    information via the move list either.
 */

import {
  HIDDEN_CARD,
  HIDDEN_STATUS,
  type GameState,
  type MaskedGameState,
  type MaskedPlayerState,
  type RulesDsl,
  type SeatIndex,
} from '@hcg/shared';
import { handLimit, visibleHandCount } from '@hcg/shared';
import { generateLegalMoves } from '../engine/legal-moves.js';
import { teamKeyForSeat } from '../engine/state.js';

export type Viewer = SeatIndex | 'SPECTATOR';

/**
 * Match-level facts that live on the `MatchManager` rather than in
 * `GameState` — the client needs them alongside the state, and they carry no
 * hidden information. Optional so callers that only want the game projection
 * (the AI prompt builder) need not supply them.
 */
export interface MaskContext {
  readonly matchOver?: boolean;
  readonly nextRoundInMs?: number | null;
}

function maskPlayer(
  rules: RulesDsl,
  phaseName: string,
  player: GameState['players'][number],
  viewer: Viewer,
  playerCount: number,
): MaskedPlayerState {
  const isSelf = viewer !== 'SPECTATOR' && player.seat === viewer;
  // Staged-deal games (29: `deck.deal.biddingHandSize`) keep the back half of
  // the hand concealed — even from its own owner — until trump selection
  // resolves. Every other plugin gets the real count back unchanged.
  const cap = visibleHandCount(rules, phaseName, player.hand.length);
  const visibleHand = player.hand.slice(0, cap);
  return {
    seat: player.seat,
    name: player.name,
    isAI: player.isAI,
    hand: isSelf ? visibleHand : visibleHand.map(() => HIDDEN_CARD),
    handCount: cap,
    tricksWon: player.tricksWon,
    bid: player.bid,
    teamKey: rules.players.topology === 'fixed-pairs' ? teamKeyForSeat(rules, player.seat, playerCount) : null,
  };
}

export function maskGameState(
  rules: RulesDsl,
  state: GameState,
  viewer: Viewer,
  context: MaskContext = {},
): MaskedGameState {
  const viewerIsDeclarer = viewer !== 'SPECTATOR' && viewer === state.declarerSeat;
  const trumpSuit = state.trumpSuit === null
    ? null
    : state.trumpRevealed || viewerIsDeclarer
      ? state.trumpSuit
      : HIDDEN_STATUS;

  const legalMoves = viewer !== 'SPECTATOR' && viewer === state.turnSeat ? generateLegalMoves(rules, state) : [];

  // Which side of the result the viewer landed on. Resolved here rather than
  // on the client so the client never needs to know how a game groups seats
  // into competitors — a solo game and a partnership game answer identically.
  const result = state.lastResult;
  let viewerWon: boolean | null = null;
  if (result !== null && viewer !== 'SPECTATOR') {
    const viewerKey = teamKeyForSeat(rules, viewer, state.players.length);
    const winners = result.scope === 'GAME' ? result.winnerKeys : result.roundWinnerKeys;
    viewerWon = winners.includes(viewerKey);
  }

  return {
    gameId: state.gameId,
    matchId: state.matchId,
    phase: state.phase,
    dealerSeat: state.dealerSeat,
    turnSeat: state.turnSeat,
    declarerSeat: state.declarerSeat,
    trumpSuit,
    trumpRevealed: state.trumpRevealed,
    players: state.players.map((p) => maskPlayer(rules, state.phase, p, viewer, state.players.length)),
    currentTrick: state.currentTrick,
    lastTrick: state.lastTrick,
    // Unmasked on purpose: every card here was played face up. Difficulty-based
    // trimming for AI seats happens in `compilePrompt`, downstream of this —
    // masking answers "what may this viewer see", not "how much does this
    // particular bot bother to use".
    completedTricks: state.completedTricks,
    leadSuit: state.leadSuit,
    kittyCount: state.kitty.length,
    teamScores: state.teamScores,
    handPoints: state.handPoints,
    bags: state.bags,
    scoringBasis: rules.scoring.contractBasis,
    lowerScoreWins: rules.scoring.lowerIsBetter === true,
    handNumber: state.handNumber,
    // A target-score game has no predetermined length, so the client shows a
    // bare round number rather than "round 2 of N".
    totalHands:
      state.maxHandsOverride ??
      rules.scoring.maxHands ??
      (rules.scoring.targetScore === undefined ? handLimit(rules) : null),
    activeMicroPhase: state.activeMicroPhase,
    viewerSeat: viewer,
    legalMoves,
    lastResult: result,
    viewerWon,
    matchOver: context.matchOver ?? false,
    nextRoundInMs: context.nextRoundInMs ?? null,
  };
}
