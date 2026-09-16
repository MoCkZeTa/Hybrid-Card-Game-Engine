/**
 * The WebSocket transport: everything between a browser's socket and the
 * `MatchGateway`. It owns the connection lifecycle and nothing about the game.
 *
 * What it defends against, and why each matters here specifically:
 *
 *  - **Dead connections.** A laptop lid closing, a phone leaving wifi, a proxy
 *    dropping an idle tunnel — none of these produce a `close` event. TCP can
 *    take minutes to notice, and for all that time the seat is held by a
 *    "connected" player who cannot move, which stalls the whole table. RFC 6455
 *    ping/pong finds these in one interval.
 *  - **Half-open the other way.** The browser cannot send ping frames, so the
 *    client does the same check with app-level `PING`/`PONG` (see `protocol.ts`).
 *  - **Slow consumers.** A client that stops reading makes `ws` buffer state
 *    updates in our heap indefinitely. Past a threshold the socket is dropped:
 *    something that far behind is not playing anyway, and it will reconnect and
 *    resync from a fresh snapshot.
 *  - **Unauthenticated squatters.** A socket that never sends `AUTHENTICATE`
 *    costs timers and memory. It gets a short window and then goes.
 *  - **Floods.** Per-connection token bucket, plus a hard message-size cap
 *    enforced by `ws` itself before the frame is ever buffered.
 *  - **Connection storms.** Global and per-user caps, so one user reconnecting
 *    in a loop cannot exhaust file descriptors for everyone.
 *
 * Reconnection is the client's job (`useGameConnection.ts`); this side just has
 * to make sure the state a reconnecting client resyncs to is correct, which is
 * why `JOIN` is idempotent and re-sends a full snapshot.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  WS_CLOSE,
  type AuthUser,
  type BotLevel,
  type ClientMessage,
  type ErrorMessage,
  type GameSummary,
  type SeatIndex,
  type ServerMessage,
} from '@hcg/shared';
import type { MatchGateway, Fanout } from '../core/cluster/match-gateway.js';
import { MatchNotFoundError, MatchUnavailableError, NotHostError, SeatTakenError } from '../core/errors.js';
import type { AuthService } from '../core/auth/auth-service.js';
import type { RateLimiter } from '../core/ratelimit/rate-limiter.js';
import { LocalConnectionRegistry, type ConnectionRegistry } from '../core/cluster/connection-registry.js';
import { WS_CREATE_RULE, WS_MESSAGE_RULE } from '../core/ratelimit/rate-limiter.js';
import { isOriginAllowed, type OriginPolicy } from './origin.js';

/** Largest client frame accepted. A `SUBMIT_MOVE` is ~120 bytes; 16 KiB is generous. */
const MAX_PAYLOAD_BYTES = 16 * 1024;

/**
 * Drop a socket whose unsent backlog passes this. One masked state is a few KiB,
 * so this is roughly "a hundred updates behind" — far past any real network hiccup.
 */
const MAX_BUFFERED_BYTES = 1024 * 1024;

export interface WsServerOptions {
  readonly httpServer: HttpServer;
  readonly gateway: MatchGateway;
  readonly authService: AuthService;
  readonly rateLimiter: RateLimiter;
  readonly originPolicy: OriginPolicy;
  /** Supplies the plugin catalog for `LIST_GAMES`, filtered to what `userId` may see. */
  readonly listGames: (userId: string) => Promise<readonly GameSummary[]>;
  /** Called with (gameId, hostName, humanSeats) when a match starts, for logging. */
  readonly onMatchStart?: (gameId: string, hostName: string, humanSeats: readonly SeatIndex[]) => void;
  readonly heartbeatIntervalMs?: number;
  readonly authTimeoutMs?: number;
  readonly maxConnections?: number;
  readonly maxConnectionsPerUser?: number;
  /**
   * Counts a user's sockets across every node. Defaults to a local registry,
   * which is exact while there is one node and an undercount the moment there
   * are more — see `core/cluster/connection-registry.ts`.
   */
  readonly connectionRegistry?: ConnectionRegistry;
}

interface Connection {
  readonly id: string;
  readonly ws: WebSocket;
  readonly ip: string;
  user: AuthUser | null;
  matchId: string | null;
  seat: SeatIndex | null;
  /** Cleared by the heartbeat sweep, set by the pong handler. */
  alive: boolean;
  /** Unsubscribes this connection from its match's fan-out. */
  unwatch: (() => void) | null;
  /** Guards against a second `JOIN`/`ENTER_ROOM` racing the first. */
  busy: boolean;
}

export class WsServer {
  private readonly wss: WebSocketServer;
  private readonly connections = new Set<Connection>();
  private readonly byUser = new Map<string, Set<Connection>>();
  private readonly opts: WsServerOptions;
  private readonly heartbeatIntervalMs: number;
  private readonly authTimeoutMs: number;
  private readonly maxConnections: number;
  private readonly maxConnectionsPerUser: number;
  private readonly connectionRegistry: ConnectionRegistry;
  /**
   * How long a registry entry survives without a heartbeat. Three intervals,
   * so a single missed sweep (or a slow one) never drops a live connection out
   * of the count and lets the cap be exceeded.
   */
  private readonly connectionLeaseMs: number;
  private heartbeat: NodeJS.Timeout | null = null;
  private closing = false;

  constructor(opts: WsServerOptions) {
    this.opts = opts;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 30_000;
    this.authTimeoutMs = opts.authTimeoutMs ?? 10_000;
    this.maxConnections = opts.maxConnections ?? 10_000;
    this.maxConnectionsPerUser = opts.maxConnectionsPerUser ?? 8;
    this.connectionRegistry = opts.connectionRegistry ?? new LocalConnectionRegistry();
    this.connectionLeaseMs = this.heartbeatIntervalMs * 3;

    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_PAYLOAD_BYTES,
      // permessage-deflate is off deliberately. Our messages are small JSON and
      // the `ws` maintainers document a real memory-fragmentation cost for it;
      // paying that to save a few KiB per state update is the wrong trade.
      perMessageDeflate: false,
    });

    // `noServer` + a manual upgrade handler so a bad origin or an overloaded
    // server is rejected with an HTTP response, before any WebSocket state is
    // allocated for it.
    opts.httpServer.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));

    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
  }

  start(): void {
    this.heartbeat = setInterval(() => this.sweep(), this.heartbeatIntervalMs);
    this.heartbeat.unref?.();
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  // ---- Upgrade --------------------------------------------------------------

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (this.closing) return reject(socket, 503, 'Server shutting down');

    if (!isOriginAllowed(req.headers.origin, this.opts.originPolicy)) {
      console.warn(`[ws] rejected upgrade from disallowed origin "${req.headers.origin ?? ''}"`);
      return reject(socket, 403, 'Origin not allowed');
    }

    if (this.connections.size >= this.maxConnections) {
      console.warn(`[ws] rejected upgrade — at connection limit (${this.maxConnections})`);
      return reject(socket, 503, 'Server at capacity');
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
  }

  // ---- Lifecycle ------------------------------------------------------------

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const conn: Connection = {
      id: randomUUID(),
      ws,
      ip: clientIp(req),
      user: null,
      matchId: null,
      seat: null,
      alive: true,
      unwatch: null,
      busy: false,
    };
    this.connections.add(conn);

    // A socket that never authenticates is either a probe or a stuck client.
    const authTimer = setTimeout(() => {
      if (!conn.user) this.closeConnection(conn, WS_CLOSE.AUTH_TIMEOUT, 'Authentication timed out');
    }, this.authTimeoutMs);
    authTimer.unref?.();

    ws.on('pong', () => {
      conn.alive = true;
    });

    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        this.send(conn, { type: 'ERROR', code: 'MALFORMED_MESSAGE', message: 'Binary frames are not accepted' });
        return;
      }
      void this.handleMessage(conn, raw.toString()).catch((err: unknown) => {
        console.error('[ws] message handler failed:', err);
        this.sendError(conn, 'INTERNAL', 'Something went wrong handling that message');
      });
    });

    // Without this, a socket error (a reset mid-write, most often) is an
    // unhandled 'error' event, which in Node means the process dies.
    ws.on('error', (err: Error) => {
      console.warn(`[ws] socket error on connection ${conn.id}: ${err.message}`);
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      this.teardown(conn);
    });
  }

  private teardown(conn: Connection): void {
    this.connections.delete(conn);
    conn.unwatch?.();
    conn.unwatch = null;

    if (conn.user) {
      const peers = this.byUser.get(conn.user.id);
      peers?.delete(conn);
      if (peers?.size === 0) this.byUser.delete(conn.user.id);
      // Give the slot back now rather than letting the lease run out, so a
      // player who closes a tab and reopens it is not briefly at their cap.
      void this.connectionRegistry.release(conn.user.id, conn.id).catch(() => undefined);
    }

    if (conn.matchId && conn.user) {
      void this.opts.gateway.reportDisconnect(conn.matchId, conn.user.id, conn.id);
    }
  }

  private closeConnection(conn: Connection, code: number, reason: string): void {
    try {
      conn.ws.close(code, reason);
    } catch {
      /* already closing */
    }
    // `close` waits for the peer's close frame, which a wedged client will
    // never send. Force it after a moment.
    const timer = setTimeout(() => conn.ws.terminate(), 2_000);
    timer.unref?.();
  }

  // ---- Heartbeat ------------------------------------------------------------

  /**
   * One round per interval: anything that did not answer the previous ping is
   * gone, so terminate it (not `close` — there is no peer left to complete a
   * closing handshake with) and ping everyone else.
   */
  private sweep(): void {
    for (const conn of [...this.connections]) {
      if (!conn.alive) {
        console.warn(`[ws] connection ${conn.id} missed its heartbeat — terminating`);
        conn.ws.terminate();
        this.teardown(conn);
        continue;
      }

      if (conn.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        console.warn(`[ws] connection ${conn.id} is ${conn.ws.bufferedAmount} bytes behind — dropping`);
        this.closeConnection(conn, WS_CLOSE.POLICY_VIOLATION, 'Client too far behind');
        continue;
      }

      // The heartbeat doubles as the registry lease renewal: one sweep keeps
      // both the socket and its cluster-wide entry alive.
      if (conn.user) {
        void this.connectionRegistry
          .register(conn.user.id, conn.id, this.connectionLeaseMs)
          .catch(() => undefined);
      }

      conn.alive = false;
      try {
        conn.ws.ping();
      } catch {
        conn.ws.terminate();
        this.teardown(conn);
      }
    }
  }

  // ---- Sending --------------------------------------------------------------

  private send(conn: Connection, message: ServerMessage): void {
    if (conn.ws.readyState !== conn.ws.OPEN) return;
    if (conn.ws.bufferedAmount > MAX_BUFFERED_BYTES) return; // the sweep will drop it
    conn.ws.send(JSON.stringify(message), (err) => {
      if (err) console.warn(`[ws] send failed on connection ${conn.id}: ${err.message}`);
    });
  }

  private sendError(conn: Connection, code: ErrorMessage['code'], message: string, retryAfterMs?: number): void {
    this.send(conn, { type: 'ERROR', code, message, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
  }

  /** Turns a gateway/engine error into the closest wire error code. */
  private reportError(conn: Connection, err: unknown): void {
    if (err instanceof SeatTakenError) return this.sendError(conn, 'SEAT_TAKEN', err.message);
    if (err instanceof NotHostError) return this.sendError(conn, 'NOT_HOST', err.message);
    if (err instanceof MatchNotFoundError) return this.sendError(conn, 'MATCH_NOT_FOUND', err.message);
    if (err instanceof MatchUnavailableError) {
      return this.sendError(conn, 'MATCH_UNAVAILABLE', err.message, 2_000);
    }
    return this.sendError(conn, 'INVALID_MOVE', (err as Error).message);
  }

  // ---- Fan-out --------------------------------------------------------------

  /**
   * Points a connection at a match's broadcasts, replacing whatever it was
   * watching. Called on `ENTER_ROOM` and on `JOIN` — including a reconnecting
   * client's `JOIN`, which is why it must be safe to call repeatedly.
   */
  private async watch(conn: Connection, matchId: string): Promise<void> {
    conn.unwatch?.();
    conn.matchId = matchId;
    conn.unwatch = await this.opts.gateway.watch(matchId, (fanout) => this.deliver(conn, fanout));
  }

  private deliver(conn: Connection, fanout: Fanout): void {
    if (fanout.kind === 'ROOM') {
      this.send(conn, { type: 'ROOM_UPDATE', room: fanout.room });
      return;
    }
    // A watcher with no seat still gets the table — they entered the room and
    // never sat down, and watching beats being stranded on a room screen for a
    // match that has already started.
    const state = conn.seat === null ? fanout.spectator : fanout.bySeat[conn.seat];
    if (state) this.send(conn, { type: 'STATE_UPDATE', state });
  }

  // ---- Messages -------------------------------------------------------------

  private async handleMessage(conn: Connection, raw: string): Promise<void> {
    let message: ClientMessage;
    try {
      message = JSON.parse(raw) as ClientMessage;
    } catch {
      this.sendError(conn, 'MALFORMED_MESSAGE', 'Message was not valid JSON');
      return;
    }
    if (typeof message !== 'object' || message === null || typeof message.type !== 'string') {
      this.sendError(conn, 'MALFORMED_MESSAGE', 'Message had no "type"');
      return;
    }

    // Heartbeats are answered before the rate limiter, so a client that has
    // genuinely overrun its budget can still tell it is connected while it
    // backs off — otherwise it would conclude the link is dead and reconnect,
    // which is the opposite of what an overloaded server wants.
    if (message.type === 'PING') {
      this.send(conn, { type: 'PONG', nonce: message.nonce });
      return;
    }

    const budget = await this.opts.rateLimiter.consume(`ws:${conn.id}`, WS_MESSAGE_RULE);
    if (!budget.allowed) {
      this.sendError(conn, 'RATE_LIMITED', 'Slow down — too many messages', budget.retryAfterMs);
      return;
    }

    if (message.type === 'AUTHENTICATE') {
      await this.handleAuthenticate(conn, message.token);
      return;
    }

    if (!conn.user) {
      this.sendError(conn, 'UNAUTHENTICATED', 'Send AUTHENTICATE before any other message');
      return;
    }

    switch (message.type) {
      case 'LIST_GAMES':
        this.send(conn, { type: 'GAMES_LIST', games: await this.opts.listGames(conn.user!.id) });
        return;

      case 'CREATE_MATCH':
        return this.handleCreate(conn, message.gameId, message.playerCount, message.maxHands);

      case 'ENTER_ROOM':
        return this.handleEnterRoom(conn, message.matchId);

      case 'JOIN':
        return this.handleJoin(conn, message.matchId, message.seat as SeatIndex);

      case 'START_MATCH':
        return this.handleStart(conn, message.matchId, message.botLevel);

      case 'SUBMIT_MOVE':
        return this.handleMove(conn, message.matchId, message.seat as SeatIndex, message.moveId);

      case 'LEAVE_MATCH':
        return this.handleLeave(conn, message.matchId);
    }
  }

  private async handleAuthenticate(conn: Connection, token: string): Promise<void> {
    const user = typeof token === 'string' && token.length > 0 ? await this.opts.authService.validateToken(token) : null;
    if (!user) {
      this.sendError(conn, 'UNAUTHENTICATED', 'Invalid or expired session token');
      // Closing rather than leaving it open tells the client this is not worth
      // retrying — `shouldReconnect` treats AUTH_FAILED as terminal.
      this.closeConnection(conn, WS_CLOSE.AUTH_FAILED, 'Invalid session');
      return;
    }

    // Re-authenticating on an existing socket (a token refresh) must not leave
    // the old identity's bookkeeping behind.
    if (conn.user && conn.user.id !== user.id) {
      this.byUser.get(conn.user.id)?.delete(conn);
    }
    conn.user = user;

    let peers = this.byUser.get(user.id);
    if (!peers) {
      peers = new Set();
      this.byUser.set(user.id, peers);
    }
    peers.add(conn);

    // One user opening tabs without bound is usually a reconnect loop. The
    // count comes from the registry rather than `peers.size`, because on a
    // multi-node deployment this node holds only a fraction of the user's
    // sockets and its own map would report a cap several times larger than the
    // configured one.
    const total = await this.connectionRegistry
      .register(user.id, conn.id, this.connectionLeaseMs)
      .catch(() => peers.size);

    if (total > this.maxConnectionsPerUser) {
      // Evict the oldest rather than refusing the newest — the newest is the
      // one the person is actually looking at.
      let excess = total - this.maxConnectionsPerUser;
      for (const peer of [...peers]) {
        if (excess <= 0) break;
        if (peer === conn) continue;
        peers.delete(peer);
        void this.connectionRegistry.release(user.id, peer.id).catch(() => undefined);
        this.closeConnection(peer, WS_CLOSE.POLICY_VIOLATION, 'Too many connections for this account');
        excess--;
      }

      // Still over: every remaining socket belongs to another node, and this
      // one cannot close them. Refusing the newest is the wrong end to give up
      // — but the alternative is a bus round trip asking a peer node to drop a
      // connection, and the cap exists to contain a runaway reconnect loop,
      // which this stops just as well.
      if (excess > 0) {
        void this.connectionRegistry.release(user.id, conn.id).catch(() => undefined);
        peers.delete(conn);
        this.sendError(conn, 'RATE_LIMITED', 'Too many open connections for this account');
        this.closeConnection(conn, WS_CLOSE.POLICY_VIOLATION, 'Too many connections for this account');
        return;
      }
    }

    this.send(conn, { type: 'AUTHENTICATED', userId: user.id, displayName: user.displayName });
  }

  private async handleCreate(
    conn: Connection,
    gameId: string,
    playerCount?: number,
    maxHands?: number,
  ): Promise<void> {
    const budget = await this.opts.rateLimiter.consume(`create:${conn.user!.id}`, WS_CREATE_RULE);
    if (!budget.allowed) {
      this.sendError(conn, 'RATE_LIMITED', 'You are creating rooms too quickly', budget.retryAfterMs);
      return;
    }
    try {
      const matchId = await this.opts.gateway.createRoom(gameId, conn.user!.id, playerCount, maxHands);
      this.send(conn, { type: 'MATCH_CREATED', matchId });
    } catch (err) {
      this.sendError(conn, 'MATCH_NOT_FOUND', (err as Error).message);
    }
  }

  private async handleEnterRoom(conn: Connection, matchId: string): Promise<void> {
    if (conn.busy) return;
    conn.busy = true;
    try {
      const room = await this.opts.gateway.enterRoom(matchId);
      await this.watch(conn, matchId);
      // Watchers count as present too. A match is only "empty" — and so only
      // terminated — when nobody at all is looking at it, which includes the
      // host who started an all-AI table and never sat down.
      this.opts.gateway.trackPresence(matchId, { userId: conn.user!.id, token: conn.id });
      this.send(conn, { type: 'ROOM_UPDATE', room });
    } catch (err) {
      this.reportError(conn, err);
    } finally {
      conn.busy = false;
    }
  }

  /**
   * Dual-purpose, as before: claims a seat in a pending room, or reconnects to
   * a seat in a live match. The gateway decides which, since only the owning
   * node knows the match's phase.
   */
  private async handleJoin(conn: Connection, matchId: string, seat: SeatIndex): Promise<void> {
    if (conn.busy) return;
    conn.busy = true;
    try {
      const result = await this.opts.gateway.join({
        matchId,
        seat,
        userId: conn.user!.id,
        displayName: conn.user!.displayName,
        token: conn.id,
      });

      conn.seat = seat;
      await this.watch(conn, matchId);
      this.opts.gateway.trackPresence(matchId, { userId: conn.user!.id, token: conn.id });

      if (result.kind === 'ROOM') this.send(conn, { type: 'ROOM_UPDATE', room: result.room });
      else this.send(conn, { type: 'STATE_UPDATE', state: result.state });
    } catch (err) {
      this.reportError(conn, err);
    } finally {
      conn.busy = false;
    }
  }

  private async handleStart(conn: Connection, matchId: string, botLevel?: BotLevel): Promise<void> {
    try {
      const room = await this.opts.gateway.enterRoom(matchId);

      // Seats with a socket open on *this* node right now. Players connected
      // through another node are covered by that node's presence sync, which
      // has already reached the owner by the time anyone can click Start.
      const connectedSeats = [...this.connections]
        .filter((c) => c.matchId === matchId && c.seat !== null && c.user !== null)
        .map((c) => ({ seat: c.seat!, userId: c.user!.id, token: c.id, nodeId: this.opts.gateway.nodeId }));

      this.opts.onMatchStart?.(
        room.gameId,
        conn.user!.displayName,
        room.seats.filter((s) => s.userId !== null).map((s) => s.seat),
      );

      await this.opts.gateway.startMatch(matchId, conn.user!.id, connectedSeats, botLevel);
      // Seatless watchers (the host of an all-AI table, most often) are not in
      // `connectedSeats`, so tell the owner about them now rather than a
      // presence tick later — the turn loop will not run while it believes
      // the table is empty.
      await this.opts.gateway.syncPresenceNow(matchId);
    } catch (err) {
      this.reportError(conn, err);
    }
  }

  private async handleMove(conn: Connection, matchId: string, seat: SeatIndex, moveId: string): Promise<void> {
    try {
      await this.opts.gateway.submitMove(matchId, seat, moveId, conn.user!.id);
    } catch (err) {
      this.reportError(conn, err);
    }
  }

  /**
   * Explicit leave — the player navigated away from a match without closing
   * the socket. Same three things `teardown` does on socket close:
   *  1. Unsubscribe from match fan-out.
   *  2. Clear `matchId` and `seat` on the connection object.
   *  3. Report the disconnect so the gateway can start the abandoned-match
   *     countdown if the table is now empty.
   *
   * Silently ignored if the connection is not currently watching `matchId`
   * (duplicate leaves, or a leave that races a reconnect, are safe).
   */
  private handleLeave(conn: Connection, matchId: string): void {
    if (conn.matchId !== matchId) return; // stale or duplicate — ignore
    conn.unwatch?.();
    conn.unwatch = null;
    conn.matchId = null;
    conn.seat = null;
    if (conn.user) {
      void this.opts.gateway.reportDisconnect(matchId, conn.user.id, conn.id);
    }
  }

  // ---- Shutdown -------------------------------------------------------------

  /**
   * Closes every socket with `GOING_AWAY` so clients reconnect promptly (to
   * whichever instance survives the deploy) instead of waiting out a heartbeat
   * timeout, and reports each disconnect so seats are not left pinned to a
   * process that is about to exit.
   */
  async close(): Promise<void> {
    this.closing = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;

    const disconnects = [...this.connections].map((conn) => {
      conn.unwatch?.();
      conn.unwatch = null;
      this.closeConnection(conn, WS_CLOSE.GOING_AWAY, 'Server restarting');
      return conn.matchId && conn.user
        ? this.opts.gateway.reportDisconnect(conn.matchId, conn.user.id, conn.id)
        : Promise.resolve();
    });

    await Promise.allSettled(disconnects);
    this.connections.clear();
    this.byUser.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}

function reject(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/**
 * Behind a load balancer the socket's own address is the balancer's. Trust
 * `x-forwarded-for` only when explicitly told to — otherwise any client could
 * spoof the header and dodge the per-IP auth rate limit.
 */
function clientIp(req: IncomingMessage): string {
  if (process.env.TRUST_PROXY === 'true') {
    const forwarded = req.headers['x-forwarded-for'];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/** Exported for the HTTP side, which needs the same trust decision. */
export { clientIp };
