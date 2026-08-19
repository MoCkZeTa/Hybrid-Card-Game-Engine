/**
 * Thin typed wrapper around the raw WebSocket, speaking the exact
 * `ClientMessage` / `ServerMessage` union from `@hcg/shared` (the same types
 * the backend server uses) so the wire contract can't silently drift between
 * the two sides.
 *
 * Beyond typing, this hook is responsible for the connection surviving real
 * networks:
 *
 *  - **Reconnects automatically** with exponential backoff and jitter. Jitter
 *    matters more than it looks: without it, a server restart brings every
 *    client back at the same instant, and the thundering herd knocks it over
 *    again. It also stops retrying when the server says the token is bad, since
 *    reconnecting would just replay the same rejection forever.
 *  - **Resumes where it left off.** The server treats `JOIN` as idempotent and
 *    replies with a fresh snapshot, so re-sending the last room/seat after a
 *    reconnect puts the player straight back at the table rather than in the
 *    lobby. Reconnecting fast enough also gets the seat back from the AI, which
 *    takes over a seat whose player has no live connection.
 *  - **Detects dead links the browser hides.** `readyState` stays OPEN long
 *    after a tunnel has silently died, and the WebSocket API gives a browser no
 *    way to send a ping frame. So the client sends its own `PING` and closes
 *    the socket if no `PONG` comes back — which triggers the reconnect above.
 *  - **Reconnects on wake.** A laptop resuming from sleep or a tab coming back
 *    to the foreground almost always has a stale socket; checking immediately
 *    beats waiting for the next heartbeat to notice.
 *  - **Keeps sessions from bleeding into each other.** Signing out and back in
 *    swaps the token, which tears this hook's socket down and builds a new one.
 *    Every callback below therefore checks that it still belongs to the current
 *    session before touching shared state: a socket from the previous one closes
 *    *after* the next has already opened, and left unguarded it would reconnect
 *    with the dead token and knock the live session out from under the player.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  shouldReconnect,
  type BotLevel,
  type ClientMessage,
  type ErrorMessage,
  type GameSummary,
  type MaskedGameState,
  type RoomState,
  type ServerMessage,
} from '@hcg/shared';

/** How the UI should describe the link right now. */
export type ConnectionStatus = 'connecting' | 'online' | 'reconnecting' | 'offline';

export interface GameConnection {
  readonly connected: boolean;
  readonly authenticated: boolean;
  readonly status: ConnectionStatus;
  /** Which reconnect attempt we're on. 0 while healthy — useful for "retrying (3)…" copy. */
  readonly reconnectAttempt: number;
  /** Set when the server rejected our token; the app should sign the user out. */
  readonly sessionExpired: boolean;
  readonly matchId: string | null;
  readonly room: RoomState | null;
  readonly state: MaskedGameState | null;
  readonly games: readonly GameSummary[];
  readonly lastError: ErrorMessage | null;
  createMatch(gameId: string, playerCount?: number, maxHands?: number): void;
  enterRoom(matchId: string): void;
  claimSeat(matchId: string, seat: number): void;
  startMatch(matchId: string, botLevel?: BotLevel): void;
  submitMove(seat: number, moveId: string): void;
  refreshGames(): void;
  clearError(): void;
  leaveMatch(): void;
}

/** Backoff schedule. Caps at 15s so a long outage still recovers promptly once it ends. */
const BASE_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 15_000;
/** Client heartbeat: send a PING this often, and give up on the socket if no PONG lands in time. */
const PING_INTERVAL_MS = 20_000;
const PONG_TIMEOUT_MS = 10_000;

function backoffDelay(attempt: number): number {
  const exponential = Math.min(MAX_RECONNECT_DELAY_MS, BASE_RECONNECT_DELAY_MS * 2 ** attempt);
  // Full jitter: anywhere in [0, exponential). Spreads a synchronised herd of
  // clients out across the whole window instead of clustering them at its end.
  return Math.random() * exponential;
}

export function useGameConnection(wsUrl: string, token: string | null): GameConnection {
  const wsRef = useRef<WebSocket | null>(null);
  const queueRef = useRef<ClientMessage[]>([]);
  const matchIdRef = useRef<string | null>(null);
  /** What to re-send after a reconnect to land back where we were. */
  const resumeRef = useRef<{ matchId: string; seat: number | null } | null>(null);
  const attemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pongTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * True only between `AUTHENTICATED` and the socket closing. Outbound messages
   * wait for it rather than for `readyState === OPEN`: in the window between the
   * two the server answers everything except `AUTHENTICATE` with
   * `UNAUTHENTICATED`.
   */
  const authenticatedRef = useRef(false);
  /** Lets the visibility/online listeners reach the current socket without re-subscribing. */
  const checkLinkRef = useRef<() => void>(() => {});
  /**
   * Mirrors the `sessionExpired` state so `checkLinkRef` can read it without
   * being rebuilt — and re-subscribing every wake listener — on each change.
   */
  const sessionExpiredRef = useRef(false);

  const [connected, setConnected] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [matchId, setMatchId] = useState<string | null>(null);
  const [room, setRoom] = useState<RoomState | null>(null);
  const [state, setState] = useState<MaskedGameState | null>(null);
  const [games, setGames] = useState<readonly GameSummary[]>([]);
  const [lastError, setLastError] = useState<ErrorMessage | null>(null);

  useEffect(() => {
    if (!token) return;

    /**
     * Scoped to *this* run of the effect, deliberately — a shared ref cannot do
     * this job. When the token changes, React runs the cleanup and the next
     * effect back to back, but the old socket's `close` event only lands a tick
     * later; by then a shared "disposed" ref has already been reset to false for
     * the new session, so the dead socket happily reconnects with the *previous*
     * token, overwrites `wsRef`, and gets rejected — signing the user back out
     * seconds after they signed in.
     */
    let cancelled = false;
    authenticatedRef.current = false;
    // A new session starts clean: an error raised by the session that just
    // ended (typically the UNAUTHENTICATED that killed it) must not be left on
    // screen for the one that just began.
    setSessionExpired(false);
    setLastError(null);

    const clearTimers = (): void => {
      if (pingTimerRef.current) clearInterval(pingTimerRef.current);
      if (pongTimerRef.current) clearTimeout(pongTimerRef.current);
      pingTimerRef.current = null;
      pongTimerRef.current = null;
    };

    const connect = (): void => {
      if (cancelled) return;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      setStatus(attemptRef.current === 0 ? 'connecting' : 'reconnecting');

      /**
       * Whether this socket is still the one the hook is driving. Everything
       * below is a callback that can fire after the socket has been superseded,
       * and shared refs (`wsRef`, the heartbeat timers) belong to whichever
       * socket is current — so a superseded one must touch none of them.
       */
      const isLive = (): boolean => !cancelled && wsRef.current === ws;

      ws.onopen = () => {
        if (!isLive()) {
          ws.close();
          return;
        }
        setConnected(true);
        ws.send(JSON.stringify({ type: 'AUTHENTICATE', token } satisfies ClientMessage));

        clearTimers();
        pingTimerRef.current = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({ type: 'PING', nonce: Date.now() } satisfies ClientMessage));
          // Any server message clears this, not just the PONG — traffic of any
          // kind proves the link is alive.
          if (pongTimerRef.current) clearTimeout(pongTimerRef.current);
          pongTimerRef.current = setTimeout(() => {
            // Nothing came back. `close()` runs our onclose, which reconnects.
            ws.close();
          }, PONG_TIMEOUT_MS);
        }, PING_INTERVAL_MS);
      };

      ws.onclose = (event: CloseEvent) => {
        if (!isLive()) return;
        clearTimers();
        authenticatedRef.current = false;
        setConnected(false);
        setAuthenticated(false);

        if (!shouldReconnect(event.code)) {
          // The server told us the token is no good. Retrying cannot fix that.
          setStatus('offline');
          setSessionExpired(true);
          return;
        }

        const delay = backoffDelay(attemptRef.current);
        attemptRef.current += 1;
        setReconnectAttempt(attemptRef.current);
        setStatus('reconnecting');
        reconnectTimerRef.current = setTimeout(connect, delay);
      };

      // 'error' always precedes 'close', so reconnect logic lives there alone.
      ws.onerror = () => {
        if (isLive()) setConnected(false);
      };

      ws.onmessage = (event: MessageEvent<string>) => {
        if (!isLive()) return;
        if (pongTimerRef.current) {
          clearTimeout(pongTimerRef.current);
          pongTimerRef.current = null;
        }

        let msg: ServerMessage;
        try {
          msg = JSON.parse(event.data) as ServerMessage;
        } catch {
          return;
        }

        switch (msg.type) {
          case 'AUTHENTICATED': {
            authenticatedRef.current = true;
            setAuthenticated(true);
            setStatus('online');
            attemptRef.current = 0;
            setReconnectAttempt(0);

            ws.send(JSON.stringify({ type: 'LIST_GAMES' } satisfies ClientMessage));

            // Put ourselves back where we were before the drop. The server
            // makes both of these idempotent and answers with a full snapshot.
            const resume = resumeRef.current;
            if (resume) {
              ws.send(
                JSON.stringify(
                  resume.seat === null
                    ? ({ type: 'ENTER_ROOM', matchId: resume.matchId } satisfies ClientMessage)
                    : ({ type: 'JOIN', matchId: resume.matchId, seat: resume.seat } satisfies ClientMessage),
                ),
              );
            }

            for (const queued of queueRef.current) ws.send(JSON.stringify(queued));
            queueRef.current = [];
            break;
          }
          case 'PONG':
            break;
          case 'GAMES_LIST':
            setGames(msg.games);
            break;
          case 'MATCH_CREATED':
            matchIdRef.current = msg.matchId;
            setMatchId(msg.matchId);
            break;
          case 'ROOM_UPDATE':
            setRoom(msg.room);
            break;
          case 'STATE_UPDATE':
            setRoom(null);
            setState(msg.state);
            // Once the match is live the server is the authority on which seat
            // is ours, so resume from that rather than what we asked for.
            if (msg.state.viewerSeat !== 'SPECTATOR') {
              resumeRef.current = { matchId: matchIdRef.current!, seat: msg.state.viewerSeat };
            }
            break;
          case 'ERROR':
            // Two codes never become a toast:
            //  - RATE_LIMITED is the server pacing us, not a failure.
            //  - UNAUTHENTICATED means this session is over. The AUTH_FAILED
            //    close that follows sets `sessionExpired`, and the app answers
            //    by returning to the sign-in screen — which is the whole story
            //    the player needs. A toast would instead survive the dead
            //    session and surface on the *next* one, which is exactly how
            //    "Invalid or expired session token" ended up greeting people
            //    right after a successful sign-in.
            if (msg.code === 'UNAUTHENTICATED') {
              console.warn(`[ws] authentication rejected: ${msg.message}`);
              break;
            }
            if (msg.code !== 'RATE_LIMITED') setLastError(msg);
            break;
          case 'DECISION_MADE':
            break;
        }
      };
    };

    /**
     * Called when the tab wakes or the OS reports the network is back. A socket
     * that died while suspended still reads as OPEN, so poke it and let the
     * pong timeout do the rest; if it is already closed, reconnect at once
     * instead of waiting out the remaining backoff.
     */
    checkLinkRef.current = () => {
      const ws = wsRef.current;
      if (cancelled || sessionExpiredRef.current) return;

      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
        attemptRef.current = 0;
        setReconnectAttempt(0);
        connect();
        return;
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'PING', nonce: Date.now() } satisfies ClientMessage));
        if (pongTimerRef.current) clearTimeout(pongTimerRef.current);
        pongTimerRef.current = setTimeout(() => ws.close(), PONG_TIMEOUT_MS);
      }
    };

    connect();

    return () => {
      cancelled = true;
      authenticatedRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      clearTimers();

      // Closing a socket that is still CONNECTING makes Chrome log "WebSocket
      // is closed before the connection is established" — an alarming-looking
      // line for what is just a sign-out, and one that shows up on every
      // attempt while the server is unreachable. Dropping it from `wsRef`
      // first is enough: its own `isLive()` check fails from here on, so its
      // `onopen` closes it the moment it finishes connecting, and if it never
      // connects the browser discards it anyway.
      const pending = wsRef.current;
      wsRef.current = null;
      if (pending && pending.readyState !== WebSocket.CONNECTING) pending.close();

      queueRef.current = [];
      attemptRef.current = 0;
      resumeRef.current = null;
      setAuthenticated(false);
      setConnected(false);
      setState(null);
      setRoom(null);
      setMatchId(null);
      setReconnectAttempt(0);
      // The next session gets a clean slate — no leftover games list or toast
      // from the account that just signed out.
      setGames([]);
      setLastError(null);
      matchIdRef.current = null;
    };
  }, [wsUrl, token]);

  useEffect(() => {
    sessionExpiredRef.current = sessionExpired;
  }, [sessionExpired]);

  useEffect(() => {
    const onWake = (): void => checkLinkRef.current();
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') checkLinkRef.current();
    };
    window.addEventListener('online', onWake);
    window.addEventListener('focus', onWake);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', onWake);
      window.removeEventListener('focus', onWake);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const send = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    // Queue until the handshake has completed, not merely until the socket is
    // open: anything that arrives in between is answered with UNAUTHENTICATED,
    // and the `AUTHENTICATED` handler flushes this queue anyway.
    if (!ws || ws.readyState !== WebSocket.OPEN || !authenticatedRef.current) {
      // Bounded so an offline client doesn't accumulate a queue it will replay
      // as a burst — and get rate-limited — the moment it reconnects.
      if (queueRef.current.length < 32) queueRef.current.push(msg);
      return;
    }
    ws.send(JSON.stringify(msg));
  }, []);

  const createMatch = useCallback(
    (gameId: string, playerCount?: number, maxHands?: number) =>
      send({ type: 'CREATE_MATCH', gameId, playerCount, maxHands }),
    [send],
  );

  const refreshGames = useCallback(() => send({ type: 'LIST_GAMES' }), [send]);

  const enterRoom = useCallback(
    (id: string) => {
      matchIdRef.current = id;
      resumeRef.current = { matchId: id, seat: null };
      setMatchId(id);
      send({ type: 'ENTER_ROOM', matchId: id });
    },
    [send],
  );

  const claimSeat = useCallback(
    (id: string, seat: number) => {
      matchIdRef.current = id;
      resumeRef.current = { matchId: id, seat };
      setMatchId(id);
      send({ type: 'JOIN', matchId: id, seat });
    },
    [send],
  );

  const startMatch = useCallback(
    (id: string, botLevel?: BotLevel) => {
      send({ type: 'START_MATCH', matchId: id, ...(botLevel ? { botLevel } : {}) });
    },
    [send],
  );

  const submitMove = useCallback(
    (seat: number, moveId: string) => {
      const id = matchIdRef.current;
      if (!id) return;
      send({ type: 'SUBMIT_MOVE', matchId: id, seat, moveId });
    },
    [send],
  );

  const clearError = useCallback(() => setLastError(null), []);

  const leaveMatch = useCallback(() => {
    matchIdRef.current = null;
    resumeRef.current = null;
    setMatchId(null);
    setRoom(null);
    setState(null);
  }, []);

  return {
    connected,
    authenticated,
    status,
    reconnectAttempt,
    sessionExpired,
    matchId,
    room,
    state,
    games,
    lastError,
    createMatch,
    enterRoom,
    claimSeat,
    startMatch,
    submitMove,
    refreshGames,
    clearError,
    leaveMatch,
  };
}
