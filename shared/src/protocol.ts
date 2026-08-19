/**
 * WebSocket wire protocol between the backend engine and any client
 * (the React frontend, or a future CLI/bot client). Kept as a discriminated
 * union so both sides get exhaustiveness checking from the same source.
 *
 * Auth model: a connection starts unauthenticated. The client must send
 * `AUTHENTICATE` with a token obtained from the HTTP auth endpoints before
 * any match-related message is accepted; everything else is rejected with
 * `ERROR: UNAUTHENTICATED` until then.
 */

import type { GameSummary } from './auth.js';
import type { MaskedGameState } from './game-state.js';
import type { Decision } from './moves.js';

// ---- Client -> Server -------------------------------------------------------

export interface AuthenticateMessage {
  readonly type: 'AUTHENTICATE';
  readonly token: string;
}

export interface ListGamesMessage {
  readonly type: 'LIST_GAMES';
}

/** Claims `seat` — in a not-yet-started room, or (to reconnect) in a match already under way. */
export interface JoinMessage {
  readonly type: 'JOIN';
  readonly matchId: string;
  readonly seat: number;
}

/** Registers this connection for room broadcasts without claiming a seat — used to watch the room fill up before picking one. */
export interface EnterRoomMessage {
  readonly type: 'ENTER_ROOM';
  readonly matchId: string;
}

export interface CreateMatchMessage {
  readonly type: 'CREATE_MATCH';
  readonly gameId: string;
  /** Table size. Omitted means the plugin's declared default. */
  readonly playerCount?: number;
  /**
   * How many hands this match runs. Host-only, fixed at room creation — it
   * cannot change once cards are dealt, since the scoreboard and the
   * round counter are both built against it. Omitted means the plugin's own
   * `scoring.maxHands`/`targetScore`.
   */
  readonly maxHands?: number;
}

/**
 * How hard the AI plays — same value for every AI seat in a match. Reuses
 * Groq's own `reasoning_effort` ladder (`easy` sends none, the rest send
 * increasingly higher effort) so difficulty is "how long/hard the bot
 * thinks", not a different model per level. See `provider-router.ts`.
 */
export type BotLevel = 'easy' | 'medium' | 'hard' | 'extreme';

/**
 * Host-only: deals the seats that were claimed and hands every unclaimed seat
 * to AI. `botLevel` only matters when at least one seat is unclaimed —
 * omitted means the server's configured default (`RoomState.defaultBotLevel`).
 */
export interface StartMatchMessage {
  readonly type: 'START_MATCH';
  readonly matchId: string;
  readonly botLevel?: BotLevel;
}

export interface SubmitMoveMessage {
  readonly type: 'SUBMIT_MOVE';
  readonly matchId: string;
  readonly seat: number;
  readonly moveId: string;
}

/**
 * Application-level liveness check, sent by the client.
 *
 * The server has the protocol-level ping/pong frames of RFC 6455 and uses them
 * (see `heartbeat.ts`), but a browser cannot: the WebSocket API exposes no way
 * to send a ping frame or observe a pong. Without this message a client sitting
 * behind a proxy that has silently dropped the connection would look connected
 * indefinitely — `readyState` stays OPEN until TCP notices, which can take
 * minutes. Sending this on a timer and watching for the reply is the only way
 * the browser can tell.
 */
export interface PingMessage {
  readonly type: 'PING';
  /** Echoed back in the `PONG`, so a client can measure round-trip time. */
  readonly nonce: number;
}

export type ClientMessage =
  | AuthenticateMessage
  | ListGamesMessage
  | JoinMessage
  | EnterRoomMessage
  | CreateMatchMessage
  | StartMatchMessage
  | SubmitMoveMessage
  | PingMessage;

// ---- Server -> Client -------------------------------------------------------

export interface AuthenticatedMessage {
  readonly type: 'AUTHENTICATED';
  readonly userId: string;
  readonly displayName: string;
}

export interface GamesListMessage {
  readonly type: 'GAMES_LIST';
  readonly games: readonly GameSummary[];
}

export interface MatchCreatedMessage {
  readonly type: 'MATCH_CREATED';
  readonly matchId: string;
}

/** One seat in a not-yet-started room — `userId`/`displayName` are null while the seat is open. */
export interface RoomSeatState {
  readonly seat: number;
  readonly userId: string | null;
  readonly displayName: string | null;
}

export interface RoomState {
  readonly matchId: string;
  readonly gameId: string;
  readonly gameDisplayName: string;
  readonly playerCount: number;
  /** How many hands this match will run — the host's choice, or the plugin's default. Shown to everyone in the room before they sit down. */
  readonly maxHands: number;
  readonly hostUserId: string;
  readonly seats: readonly RoomSeatState[];
  /** Preselects the host's level picker — the level the server falls back to if `START_MATCH` omits `botLevel`. */
  readonly defaultBotLevel: BotLevel;
}

export interface RoomUpdateMessage {
  readonly type: 'ROOM_UPDATE';
  readonly room: RoomState;
}

export interface StateUpdateMessage {
  readonly type: 'STATE_UPDATE';
  readonly state: MaskedGameState;
}

export interface DecisionMadeMessage {
  readonly type: 'DECISION_MADE';
  readonly seat: number;
  readonly decision: Decision;
}

export interface PongMessage {
  readonly type: 'PONG';
  readonly nonce: number;
}

export interface ErrorMessage {
  readonly type: 'ERROR';
  readonly code:
    | 'INVALID_MOVE'
    | 'NOT_YOUR_TURN'
    | 'MATCH_NOT_FOUND'
    | 'MALFORMED_MESSAGE'
    | 'UNAUTHENTICATED'
    | 'SEAT_TAKEN'
    | 'NOT_HOST'
    | 'ALREADY_STARTED'
    /** Client is sending faster than the server will accept. Back off and retry. */
    | 'RATE_LIMITED'
    /** The match exists but the server holding it is briefly unreachable — retry, don't leave. */
    | 'MATCH_UNAVAILABLE'
    | 'INTERNAL';
  readonly message: string;
  /** Set on `RATE_LIMITED` and `MATCH_UNAVAILABLE`: how long to wait before retrying. */
  readonly retryAfterMs?: number;
}

export type ServerMessage =
  | AuthenticatedMessage
  | GamesListMessage
  | MatchCreatedMessage
  | RoomUpdateMessage
  | StateUpdateMessage
  | DecisionMadeMessage
  | PongMessage
  | ErrorMessage;

// ---- Close codes ------------------------------------------------------------

/**
 * Close codes in the 4000-4999 range are reserved for the application. The
 * client branches on these to decide whether reconnecting could possibly help:
 * reconnecting after `AUTH_FAILED` just replays the same bad token, while
 * reconnecting after `GOING_AWAY` is exactly the right move.
 */
export const WS_CLOSE = {
  /** Server is shutting down (deploy, restart). Reconnect after a short delay. */
  GOING_AWAY: 4000,
  /** Token was missing, invalid, or expired. Do not retry — sign in again. */
  AUTH_FAILED: 4001,
  /** No `AUTHENTICATE` arrived within the handshake window. */
  AUTH_TIMEOUT: 4002,
  /** Server-side ping went unanswered — the connection is dead. Reconnect. */
  HEARTBEAT_TIMEOUT: 4003,
  /** Persistent flooding, or a message above the size cap. */
  POLICY_VIOLATION: 4004,
  /** The server is at its connection limit. Reconnect with a long backoff. */
  OVERLOADED: 4005,
} as const;

export type WsCloseCode = (typeof WS_CLOSE)[keyof typeof WS_CLOSE];

/** Whether a client should try to reconnect after being closed with `code`. */
export function shouldReconnect(code: number): boolean {
  return code !== WS_CLOSE.AUTH_FAILED;
}
