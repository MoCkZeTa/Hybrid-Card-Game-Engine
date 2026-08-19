/**
 * Ties the engine, AI pipeline, fog of war, and persistence together into
 * "one running match" — the thing the WebSocket layer actually talks to. No
 * networking lives here; this is pure orchestration so it can be tested
 * without opening a socket.
 *
 * A match has two phases:
 *  - **Room** (`Room`, in `rooms`): created empty — no cards dealt, nobody's
 *    turn. Players claim seats as they arrive. Nothing plays itself yet.
 *  - **Live** (`LiveMatch`, in `matches`): starts when the host calls
 *    `startMatch` — every unclaimed seat becomes AI, the deck is dealt, and
 *    the usual turn loop takes over. A matchId lives in exactly one of the
 *    two maps at a time; `startMatch` moves it from one to the other.
 *
 * A match runs as many hands as its plugin declares (`scoring.maxHands` /
 * `scoring.targetScore`, resolved by `handLimit`). Each hand ends in SCORING,
 * where the engine folds the hand into `teamScores` and emits a `ROUND`
 * result; after a short intermission — long enough for clients to show the
 * round popup — the next hand is dealt automatically. The final hand emits a
 * `GAME` result instead and the match stops there.
 *
 * The intermission is a timer rather than a "host clicks continue" gate on
 * purpose: nothing then stalls when the host closes their tab mid-match.
 */

import { randomUUID } from 'node:crypto';
import type { BotLevel, Decision, GameState, MaskedGameState, RoomState, SeatIndex } from '@hcg/shared';
import type { GamePlugin, PluginManager } from '../plugin/plugin-manager.js';
import { createMatch, startNextHand } from '../engine/state.js';
import { createRng, type Rng } from '../engine/deck.js';
import { applyMove } from '../engine/apply-move.js';
import { applyHandScoring } from '../engine/scoring.js';
import { maskGameState, type Viewer } from '../obfuscation/fog-of-war.js';
import { decideTurn } from '../ai/decide.js';
import type { BotTier } from '../ai/provider-router.js';
import type { DecisionLogger } from '../ai/decision-logger.js';
import { generateLegalMoves } from '../engine/legal-moves.js';
import { handLimit, supportedPlayerCounts, validateHandLimit } from '@hcg/shared';
import type { AsyncPersistenceWriter } from '../persistence/persist-writer.js';
import { MatchNotFoundError, NotHostError, SeatTakenError } from '../errors.js';

interface RoomSeat {
  readonly seat: SeatIndex;
  userId: string | null;
  displayName: string | null;
}

interface Room {
  readonly matchId: string;
  readonly gameId: string;
  readonly plugin: GamePlugin;
  readonly playerCount: number;
  /** Host's chosen match length, or null to use the plugin's own. */
  readonly maxHands: number | null;
  readonly hostUserId: string;
  readonly seats: RoomSeat[];
}

interface LiveMatch {
  readonly matchId: string;
  readonly plugin: GamePlugin;
  state: GameState;
  sequence: number;
  /** Highest hand number already folded into `teamScores`, so re-entering SCORING can't double-score it. */
  scoredHand: number;
  /** Set once the last hand has scored — no further hand will be dealt. */
  matchOver: boolean;
  /** Epoch ms at which the next hand deals, while a round intermission is running. */
  nextRoundAt: number | null;
  /** Kept across hands so every deal draws from one continuous stream. */
  readonly rng: Rng;
  readonly humanSeats: ReadonlySet<SeatIndex>;
  /** userId that has claimed each human seat. */
  readonly seatOwners: Map<SeatIndex, string>;
  /**
   * Live connection tokens (one per open socket) per userId, so a second
   * browser tab — or the same tab re-sending JOIN — doesn't hand control to
   * AI when one socket closes. A human seat only blocks the AI runner while
   * its owner has at least one live connection — a seat whose owner has none
   * (including right after their disconnect) plays itself via AI on its turn
   * until a human is there to take it.
   */
  readonly connectedUsers: Map<string, Set<string>>;
  /**
   * Which backend node each live connection sits on, and when we last heard
   * from that node. A socket's `close` event is the normal way a connection
   * leaves this map — but a node that is killed outright never fires one, so
   * its connections would pin their seats away from the AI forever. Every node
   * therefore re-asserts its connections on a timer (`syncNodePresence`) and
   * `evictStaleNodes` drops anything from a node that has gone quiet.
   */
  readonly connectionNodes: Map<string, string>;
  readonly nodeLastSeenAt: Map<string, number>;
  readonly decisions: Decision[];
  /**
   * Epoch ms since `connectedUsers` last became empty, or null while at least
   * one human is connected. Drives `noHumanTimeoutMs`: a match nobody is
   * watching plays AI vs AI forever otherwise, since no seat ever blocks the
   * AI runner. Reset the instant a human (re)connects.
   */
  emptySince: number | null;
  /** Set once `emptySince` has aged past `noHumanTimeoutMs` — the turn loop stops driving this match. */
  abandoned: boolean;
  /** How hard every AI seat in this match plays — one level for the whole match, chosen (or defaulted) at `startMatch`. */
  readonly botLevel: BotLevel;
}

// Re-exported so existing call sites keep importing them from here, while the
// cluster layer can import the same classes without a circular dependency.
export { MatchNotFoundError, NotHostError, SeatTakenError } from '../errors.js';

export interface MatchManagerOptions {
  readonly plugins: PluginManager;
  /** One `LLMProvider`+timeout per `BotLevel` — see `provider-router.ts#createBotTiersFromEnv`. */
  readonly botTiers: Record<BotLevel, BotTier>;
  /** Level `startMatch` falls back to when `botLevel` is omitted, and what `RoomState.defaultBotLevel` reports to clients. */
  readonly defaultBotLevel: BotLevel;
  readonly persistence: AsyncPersistenceWriter;
  /**
   * Floor on the wall-clock time between an AI seat's turn starting and its
   * move being emitted. A real LLM call already takes a while, but the
   * `forced` (single legal move) and `fallback` (timeout/provider-error)
   * paths in `decideTurn` resolve in under a millisecond — without this
   * floor, several AI turns in a row can land in the same tick and the
   * client never gets to play the card/trick animation before the next
   * state overwrites it. Default 550ms (comfortably past the ~400ms CSS
   * deal-in animation).
   */
  readonly aiMoveMinDelayMs?: number;
  /**
   * How long a finished hand sits in SCORING before the next one is dealt.
   * This is the window in which clients show the round-result popup, so it
   * wants to be long enough to actually read. Default 7000ms; tests set 0.
   */
  readonly roundIntermissionMs?: number;
  /**
   * How long a match may sit with zero connected humans before it is treated
   * as abandoned and the turn loop stops driving it — otherwise an empty
   * table plays AI vs AI forever, since no seat is ever blocked waiting on a
   * human. A brief refresh/reconnect gap is normal and shouldn't trip this;
   * default 120000ms.
   */
  readonly noHumanTimeoutMs?: number;
  /** Optional sink for AI decisions. Omitted in tests so they run silently. */
  readonly onDecision?: DecisionLogger;
}

/** Fired whenever a room's seats change or a match's state changes, so the transport layer can re-broadcast. */
export type ChangeListener = (matchId: string) => void;

/**
 * Node identity for a single-process deployment. Multi-node callers pass their
 * real node ID; this keeps the signature honest for tests and local dev.
 */
const LOCAL_NODE = 'local';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MatchManager {
  private readonly rooms = new Map<string, Room>();
  private readonly matches = new Map<string, LiveMatch>();
  private readonly listeners = new Set<ChangeListener>();

  constructor(private readonly opts: MatchManagerOptions) {}

  onChange(listener: ChangeListener): void {
    this.listeners.add(listener);
  }

  private emitChange(matchId: string): void {
    for (const listener of this.listeners) listener(matchId);
  }

  // ---- Room phase ----------------------------------------------------------

  /**
   * Opens an empty room — no cards dealt, no seats claimed. `playerCount`
   * defaults to the plugin's declared default and must be one of the counts
   * it supports. `maxHands` is the host's chosen match length; omitted uses
   * whatever the plugin declares.
   *
   * Both are fixed here rather than at START_MATCH because they determine the
   * shape of the room itself — the seat list, and the round counter every
   * joining player sees before they sit down.
   */
  async createRoom(gameId: string, hostUserId: string, playerCount?: number, maxHands?: number): Promise<string> {
    const plugin = await this.opts.plugins.getVisible(gameId, hostUserId);
    const count = playerCount ?? plugin.rules.players.defaultCount;

    const supported = supportedPlayerCounts(plugin.rules);
    if (!supported.includes(count)) {
      throw new Error(`"${gameId}" supports ${supported.join('/')} players, not ${count}`);
    }

    if (maxHands !== undefined) {
      const invalid = validateHandLimit(plugin.rules, maxHands);
      if (invalid) throw new Error(invalid);
    }

    const matchId = randomUUID();
    const seats: RoomSeat[] = Array.from({ length: count }, (_, seat) => ({
      seat,
      userId: null,
      displayName: null,
    }));
    this.rooms.set(matchId, {
      matchId,
      gameId,
      plugin,
      playerCount: count,
      maxHands: maxHands ?? null,
      hostUserId,
      seats,
    });
    return matchId;
  }

  isRoom(matchId: string): boolean {
    return this.rooms.has(matchId);
  }

  getRoomState(matchId: string): RoomState {
    const room = this.mustGetRoom(matchId);
    return {
      matchId: room.matchId,
      gameId: room.gameId,
      gameDisplayName: room.plugin.rules.displayName,
      playerCount: room.playerCount,
      maxHands: handLimit(room.plugin.rules, room.maxHands),
      hostUserId: room.hostUserId,
      seats: room.seats.map((s) => ({ seat: s.seat, userId: s.userId, displayName: s.displayName })),
      defaultBotLevel: this.opts.defaultBotLevel,
    };
  }

  /**
   * Claims `seat` in a not-yet-started room for `userId` (freeing any other
   * seat they held in the same room — a player can only sit in one spot).
   * Idempotent for the same user re-claiming their own seat.
   */
  claimRoomSeat(matchId: string, seat: SeatIndex, userId: string, displayName: string): void {
    const room = this.mustGetRoom(matchId);
    const target = room.seats[seat];
    if (!target) throw new Error(`Seat ${seat} is out of range for a ${room.playerCount}-player table`);
    if (target.userId !== null && target.userId !== userId) throw new SeatTakenError(seat);

    for (const s of room.seats) {
      if (s.userId === userId && s.seat !== seat) {
        s.userId = null;
        s.displayName = null;
      }
    }
    target.userId = userId;
    target.displayName = displayName;
    this.emitChange(matchId);
  }

  /**
   * Deals the hand and goes live: every claimed seat becomes human-controlled,
   * every unclaimed seat becomes AI. Only the room's host may call this.
   *
   * @param connectedSeats Seats with a socket open right now (seat → userId +
   *   an opaque per-connection token + the node that socket lives on),
   *   supplied by the transport layer so their owners are already "connected"
   *   the instant the match goes live — without this, AI would play their very
   *   first turn out from under them before a fresh JOIN round-trip could
   *   register it.
   * @param botLevel How hard every AI seat plays for this match. Omitted
   *   (and irrelevant when every seat is claimed) falls back to
   *   `defaultBotLevel`.
   */
  async startMatch(
    matchId: string,
    requestingUserId: string,
    connectedSeats: ReadonlyMap<SeatIndex, { userId: string; token: string; nodeId: string }>,
    botLevel?: BotLevel,
  ): Promise<void> {
    const room = this.mustGetRoom(matchId);
    if (room.hostUserId !== requestingUserId) throw new NotHostError();

    const humanSeats = new Set(room.seats.filter((s) => s.userId !== null).map((s) => s.seat));
    const aiSeats = new Set(room.seats.filter((s) => s.userId === null).map((s) => s.seat));
    const playerNames = room.seats.map((s) => s.displayName ?? (s.userId ? `Player ${s.seat}` : `AI ${s.seat}`));

    const seed = Date.now() ^ Math.floor(Math.random() * 0xffffffff);
    const rng = createRng(seed);
    const state = createMatch({
      rules: room.plugin.rules,
      gameId: room.gameId,
      matchId,
      playerCount: room.playerCount,
      dealerSeat: 0,
      playerNames,
      aiSeats,
      rng,
      maxHands: room.maxHands,
    });

    const seatOwners = new Map<SeatIndex, string>();
    for (const s of room.seats) if (s.userId !== null) seatOwners.set(s.seat, s.userId);

    const connectedUsers = new Map<string, Set<string>>();
    const connectionNodes = new Map<string, string>();
    const nodeLastSeenAt = new Map<string, number>();
    for (const [seat, info] of connectedSeats) {
      if (seatOwners.get(seat) !== info.userId) continue; // only trust it if it matches an actual claim
      let tokens = connectedUsers.get(info.userId);
      if (!tokens) {
        tokens = new Set();
        connectedUsers.set(info.userId, tokens);
      }
      tokens.add(info.token);
      connectionNodes.set(info.token, info.nodeId);
      nodeLastSeenAt.set(info.nodeId, Date.now());
    }

    const live: LiveMatch = {
      matchId,
      plugin: room.plugin,
      state,
      sequence: 0,
      scoredHand: 0,
      matchOver: false,
      nextRoundAt: null,
      rng,
      humanSeats,
      seatOwners,
      connectedUsers,
      connectionNodes,
      nodeLastSeenAt,
      decisions: [],
      emptySince: connectedUsers.size === 0 ? Date.now() : null,
      abandoned: false,
      botLevel: botLevel ?? this.opts.defaultBotLevel,
    };

    this.rooms.delete(matchId);
    this.matches.set(matchId, live);
    this.persist(live);
    this.emitChange(matchId);

    await this.runAiTurnsUntilBlocked(matchId);
  }

  // ---- Failover --------------------------------------------------------------

  /**
   * Rebuilds a live match on this node from its last durable snapshot. Used
   * when the node that owned a match died: its in-memory copy is gone, but
   * `AsyncPersistenceWriter` has been writing the full state after every move,
   * so play can resume from there.
   *
   * Two things are deliberately *not* restored, because neither is persisted
   * and neither can be guessed safely:
   *  - **Seat claims.** Which human held which seat is session state. Every
   *    seat starts unclaimed, so those seats play as AI until their owners
   *    reconnect and re-`claimSeat`. Losing a couple of turns to the AI beats
   *    handing a seat — and its hand — to whoever asks first.
   *  - **The RNG stream.** A fresh one is seeded. Deals already made are in the
   *    snapshot; only future deals differ from the counterfactual, which no
   *    player can observe.
   *  - **The bot level.** Not persisted either, so a revived match falls back
   *    to `defaultBotLevel` rather than whatever the host had picked.
   */
  adopt(persisted: { readonly gameId: string; readonly matchId: string; readonly state: GameState; readonly sequence: number }): void {
    if (this.matches.has(persisted.matchId)) return;
    const plugin = this.opts.plugins.get(persisted.gameId);
    const humanSeats = new Set(persisted.state.players.filter((p) => !p.isAI).map((p) => p.seat));

    this.matches.set(persisted.matchId, {
      matchId: persisted.matchId,
      plugin,
      state: persisted.state,
      sequence: persisted.sequence,
      // `lastResult` is set by scoring and cleared when the next hand deals, so
      // a result naming the *current* hand means that hand is already folded
      // into `teamScores`. Getting this wrong in either direction corrupts the
      // score: too low and the hand is counted twice, too high and it is lost.
      scoredHand:
        persisted.state.lastResult?.handNumber === persisted.state.handNumber
          ? persisted.state.handNumber
          : Math.max(0, persisted.state.handNumber - 1),
      matchOver: persisted.state.lastResult?.scope === 'GAME',
      nextRoundAt: null,
      rng: createRng(Date.now() ^ Math.floor(Math.random() * 0xffffffff)),
      humanSeats,
      seatOwners: new Map(),
      connectedUsers: new Map(),
      connectionNodes: new Map(),
      nodeLastSeenAt: new Map(),
      decisions: [],
      // Seat claims aren't persisted, so a freshly-adopted match always starts
      // with nobody connected — the same reconnect grace window applies here
      // as it would for any other empty stretch.
      emptySince: Date.now(),
      abandoned: false,
      botLevel: this.opts.defaultBotLevel,
    });
  }

  /** Resumes the turn loop after `adopt` — separate so the caller can wire listeners first. */
  async resume(matchId: string): Promise<void> {
    await this.runAiTurnsUntilBlocked(matchId);
  }

  // ---- Live match phase ------------------------------------------------------

  getMaskedState(matchId: string, viewer: Viewer): MaskedGameState {
    const live = this.mustGet(matchId);
    // Remaining intermission is computed per request rather than baked in at
    // scoring time, so a client that reconnects mid-countdown sees the time
    // actually left instead of restarting it.
    return maskGameState(live.plugin.rules, live.state, viewer, {
      matchOver: live.matchOver,
      nextRoundInMs: live.nextRoundAt === null ? null : Math.max(0, live.nextRoundAt - Date.now()),
    });
  }

  getDecisionLog(matchId: string): readonly Decision[] {
    return this.mustGet(matchId).decisions;
  }

  /**
   * Re-claims `seat` in an already-started match for `userId` — this is the
   * reconnect path (seats are fixed human/AI once the match is live, unlike
   * the room phase). Idempotent for the same user; rejects anyone else.
   */
  claimSeat(matchId: string, seat: SeatIndex, userId: string): void {
    const live = this.mustGet(matchId);
    if (!live.humanSeats.has(seat)) {
      throw new Error(`Seat ${seat} is AI-controlled and cannot be claimed`);
    }
    const existing = live.seatOwners.get(seat);
    if (existing !== undefined && existing !== userId) throw new SeatTakenError(seat);
    live.seatOwners.set(seat, userId);
  }

  /** True if `userId` may act for `seat` — i.e. they hold the claim on it. */
  ownsSeat(matchId: string, seat: SeatIndex, userId: string): boolean {
    return this.mustGet(matchId).seatOwners.get(seat) === userId;
  }

  /**
   * Records a live connection for `userId` on `matchId`, identified by an
   * opaque `token` unique to that connection (the caller's own socket
   * object works fine) so a second tab, or the same tab re-sending JOIN on
   * the same socket, can't be double-counted or double-removed.
   */
  connect(matchId: string, userId: string, token: string, nodeId = LOCAL_NODE): void {
    const live = this.mustGet(matchId);
    let tokens = live.connectedUsers.get(userId);
    if (!tokens) {
      tokens = new Set();
      live.connectedUsers.set(userId, tokens);
    }
    tokens.add(token);
    live.connectionNodes.set(token, nodeId);
    live.nodeLastSeenAt.set(nodeId, Date.now());
    this.touchPresence(live);
  }

  /**
   * Records a closed connection for `userId` on `matchId` (same `token`
   * passed to `connect`). Once their last connection drops, any seat they
   * hold falls under AI control on its next turn — including the current
   * one, if it's already on the clock — until they reconnect.
   */
  async disconnect(matchId: string, userId: string, token: string): Promise<void> {
    const live = this.matches.get(matchId);
    // A socket closing after its match ended (or after ownership moved) is
    // routine, not an error — there is simply nothing to update.
    if (!live) return;
    this.dropToken(live, userId, token);
    this.touchPresence(live);
    await this.runAiTurnsUntilBlocked(matchId);
  }

  private dropToken(live: LiveMatch, userId: string, token: string): void {
    const tokens = live.connectedUsers.get(userId);
    tokens?.delete(token);
    if (tokens && tokens.size === 0) live.connectedUsers.delete(userId);
    live.connectionNodes.delete(token);
  }

  /**
   * Keeps `emptySince`/`abandoned` in sync with `connectedUsers`. Called after
   * every operation that can change who is connected, so `driveAiTurns` always
   * sees an up-to-date picture regardless of which path touched presence.
   */
  private touchPresence(live: LiveMatch): void {
    if (live.connectedUsers.size === 0) {
      if (live.emptySince === null) live.emptySince = Date.now();
    } else {
      live.emptySince = null;
      live.abandoned = false;
    }
  }

  /**
   * Re-asserts the full set of connections `nodeId` currently holds for this
   * match, replacing whatever we previously believed about that node. This is
   * how presence survives in a multi-node deployment: each node repeats its
   * own list on a timer, so a `close` event lost to a network partition heals
   * on the next tick instead of pinning a seat away from the AI forever.
   *
   * Only that node's connections are touched — other nodes' presence is left
   * exactly as it was.
   */
  async syncNodePresence(
    matchId: string,
    nodeId: string,
    connections: readonly { readonly userId: string; readonly token: string }[],
  ): Promise<void> {
    const live = this.matches.get(matchId);
    if (!live) return;

    live.nodeLastSeenAt.set(nodeId, Date.now());

    const asserted = new Set(connections.map((c) => c.token));
    for (const [token, owningNode] of [...live.connectionNodes]) {
      if (owningNode !== nodeId || asserted.has(token)) continue;
      for (const [userId, tokens] of live.connectedUsers) {
        if (tokens.has(token)) this.dropToken(live, userId, token);
      }
      live.connectionNodes.delete(token);
    }

    for (const { userId, token } of connections) {
      this.connect(matchId, userId, token, nodeId);
    }

    this.touchPresence(live);
    await this.runAiTurnsUntilBlocked(matchId);
  }

  /**
   * Forgets every connection belonging to a node we have not heard from in
   * `ttlMs` — the crashed-node case, where no socket ever fires `close`. Seats
   * held by those connections fall to the AI on their next turn, which is the
   * same outcome as if those players had simply closed their tabs.
   */
  async evictStaleNodes(matchId: string, ttlMs: number): Promise<void> {
    const live = this.matches.get(matchId);
    if (!live) return;

    const cutoff = Date.now() - ttlMs;
    const stale = [...live.nodeLastSeenAt].filter(([, seen]) => seen < cutoff).map(([node]) => node);
    if (stale.length === 0) return;

    for (const nodeId of stale) {
      live.nodeLastSeenAt.delete(nodeId);
      for (const [token, owningNode] of [...live.connectionNodes]) {
        if (owningNode !== nodeId) continue;
        for (const [userId, tokens] of live.connectedUsers) {
          if (tokens.has(token)) this.dropToken(live, userId, token);
        }
        live.connectionNodes.delete(token);
      }
    }

    this.touchPresence(live);
    await this.runAiTurnsUntilBlocked(matchId);
  }

  /** Every match this node is currently running — used by lease renewal and presence sweeps. */
  liveMatchIds(): readonly string[] {
    return [...this.matches.keys()];
  }

  /** Rooms and matches both, for ownership bookkeeping. */
  allMatchIds(): readonly string[] {
    return [...this.rooms.keys(), ...this.matches.keys()];
  }

  /** Seat count of a room or live match, so the transport can mask one state per seat. */
  seatCount(matchId: string): number {
    const room = this.rooms.get(matchId);
    if (room) return room.playerCount;
    return this.mustGet(matchId).state.players.length;
  }

  /** True once the final hand has been scored. Used to release ownership of a finished match. */
  isFinished(matchId: string): boolean {
    return this.matches.get(matchId)?.matchOver ?? false;
  }

  /**
   * True once a match has had zero connected humans for longer than
   * `noHumanTimeoutMs` and the turn loop has stopped driving it. Used to
   * release ownership of a match nobody is watching, rather than letting it
   * run AI vs AI (or sit idle) forever. Reverts to false the moment a human
   * reconnects, so callers should re-check rather than cache this.
   */
  isAbandoned(matchId: string): boolean {
    return this.matches.get(matchId)?.abandoned ?? false;
  }

  /** Forgets a match entirely — called when this node hands ownership back or shuts down. */
  evict(matchId: string): void {
    this.rooms.delete(matchId);
    this.matches.delete(matchId);
  }

  async submitMove(matchId: string, seat: SeatIndex, moveId: string, userId: string): Promise<void> {
    const live = this.mustGet(matchId);
    if (live.seatOwners.get(seat) !== userId) {
      throw new Error(`You do not hold seat ${seat} in this match`);
    }
    if (live.state.turnSeat !== seat) {
      throw new Error(`It is seat ${live.state.turnSeat}'s turn, not seat ${seat}'s`);
    }
    if (!live.humanSeats.has(seat)) {
      throw new Error(`Seat ${seat} is AI-controlled and cannot receive a client move`);
    }

    live.state = applyMove(live.plugin.rules, live.state, moveId);
    live.decisions.push({ moveId, source: 'human' });
    live.sequence += 1;
    this.persist(live);
    this.emitChange(matchId);

    await this.runAiTurnsUntilBlocked(matchId);
  }

  /**
   * `submitMove` and `disconnect` can both try to drive the same match's AI
   * turns at once (a player disconnecting right as another submits a move).
   * Re-entrant calls for the same matchId await the in-flight run instead of
   * racing it.
   */
  private readonly aiRuns = new Map<string, Promise<void>>();

  private runAiTurnsUntilBlocked(matchId: string): Promise<void> {
    const inFlight = this.aiRuns.get(matchId);
    if (inFlight) return inFlight;
    const run = this.driveAiTurns(matchId).finally(() => this.aiRuns.delete(matchId));
    this.aiRuns.set(matchId, run);
    return run;
  }

  /** True if a human currently holds `seat` and has at least one live connection to the match. */
  private seatHasConnectedHuman(live: LiveMatch, seat: SeatIndex): boolean {
    const owner = live.seatOwners.get(seat);
    return owner !== undefined && (live.connectedUsers.get(owner)?.size ?? 0) > 0;
  }

  /**
   * Plays out consecutive AI turns until a connected human seat is on the
   * clock, the match ends, or a safety cap trips. Hand boundaries are crossed
   * inline — an all-AI table plays every hand of the match in one run.
   */
  private async driveAiTurns(matchId: string): Promise<void> {
    // Generous per-hand allowance (bids + trump + every card played) times the
    // number of hands this plugin can run. This only exists to break a stuck
    // phase-transition loop, so it should never bind in normal play.
    const live = this.mustGet(matchId);
    const safetyCap = 200 * handLimit(live.plugin.rules, live.state.maxHandsOverride) + 200;
    for (let i = 0; i < safetyCap; i++) {
      const live = this.mustGet(matchId);

      // With nobody connected, no seat ever blocks the AI runner — an empty
      // table would otherwise play AI vs AI to the end of the match on its
      // own. Stop driving it once the empty stretch outlasts the reconnect
      // grace period; a human coming back resets `emptySince`/`abandoned`
      // via `touchPresence` and the loop picks up again on their next move.
      const noHumanTimeoutMs = this.opts.noHumanTimeoutMs ?? 120_000;
      if (live.connectedUsers.size === 0 && live.emptySince !== null && Date.now() - live.emptySince >= noHumanTimeoutMs) {
        if (!live.abandoned) {
          live.abandoned = true;
          this.emitChange(matchId);
        }
        return;
      }

      const phaseKind = live.plugin.rules.phases.find((p) => p.name === live.state.phase)?.kind;

      if (phaseKind === 'SCORING') {
        if (live.scoredHand >= live.state.handNumber) return; // already scored and waiting out the intermission

        live.state = applyHandScoring(live.plugin.rules, live.state);
        live.scoredHand = live.state.handNumber;
        live.sequence += 1;

        if (live.state.lastResult?.scope === 'GAME') {
          live.matchOver = true;
          this.persist(live);
          this.emitChange(matchId);
          return;
        }

        // Round over but the match isn't: publish the result, hold it on
        // screen for the intermission, then deal the next hand.
        const intermissionMs = this.opts.roundIntermissionMs ?? 7000;
        live.nextRoundAt = Date.now() + intermissionMs;
        this.persist(live);
        this.emitChange(matchId);

        if (intermissionMs > 0) await sleep(intermissionMs);

        live.state = startNextHand(live.plugin.rules, live.state, live.rng);
        live.nextRoundAt = null;
        live.sequence += 1;
        this.persist(live);
        this.emitChange(matchId);
        continue;
      }

      const turnSeat = live.state.turnSeat;
      if (this.seatHasConnectedHuman(live, turnSeat)) {
        return; // block here; wait for submitMove
      }

      const turnStartedAt = Date.now();
      // `botTiers` is populated for every `BotLevel` by `createBotTiersFromEnv`
      // (or the equivalent test fixture) — `!` because `Record` indexing is
      // widened to `| undefined` under `noUncheckedIndexedAccess`.
      const tier = this.opts.botTiers[live.botLevel]!;
      // Nobody is connected to this match at all (mid reconnect-grace-period,
      // or genuinely abandoned) — nobody is watching the AI's reasoning, so
      // don't spend LLM quota on it. Play the deterministic first legal move
      // instead; a reconnecting human still resumes a live, in-progress match.
      const decision: Decision =
        live.connectedUsers.size === 0
          ? {
              moveId: generateLegalMoves(live.plugin.rules, live.state)[0]!.id,
              source: 'fallback',
              reasoning: 'No one is connected to this match; skipped the LLM call to avoid spending quota unattended.',
            }
          : await decideTurn({
              rules: live.plugin.rules,
              plugin: live.plugin,
              state: live.state,
              seat: turnSeat,
              provider: tier.provider,
              llmTimeoutMs: tier.llmTimeoutMs,
            });

      if (this.opts.onDecision) {
        // Recomputed only for the log line's human-readable label — cheap
        // (<2ms per PRD 6) and skipped entirely when no logger is attached.
        const legal = generateLegalMoves(live.plugin.rules, live.state);
        this.opts.onDecision({
          matchId: live.matchId,
          gameId: live.plugin.gameId,
          seat: turnSeat,
          playerName: live.state.players[turnSeat]?.name ?? `Seat ${turnSeat}`,
          phase: live.state.phase,
          decision,
          move: legal.find((m) => m.id === decision.moveId),
          legalMoveCount: legal.length,
        });
      }

      live.state = applyMove(live.plugin.rules, live.state, decision.moveId);
      live.decisions.push(decision);
      live.sequence += 1;
      this.persist(live);

      const minDelayMs = this.opts.aiMoveMinDelayMs ?? 550;
      const elapsedMs = Date.now() - turnStartedAt;
      if (elapsedMs < minDelayMs) await sleep(minDelayMs - elapsedMs);

      this.emitChange(matchId);
    }
    throw new Error(`Match "${matchId}" exceeded the AI-turn safety cap — likely stuck in a phase transition loop`);
  }

  private persist(live: LiveMatch): void {
    this.opts.persistence.schedule(live.matchId, live.plugin.gameId, live.sequence, live.state);
  }

  private mustGet(matchId: string): LiveMatch {
    const live = this.matches.get(matchId);
    if (!live) throw new MatchNotFoundError(matchId);
    return live;
  }

  private mustGetRoom(matchId: string): Room {
    const room = this.rooms.get(matchId);
    if (!room) {
      throw new MatchNotFoundError(
        matchId,
        `No open room "${matchId}" — it may already have started, or never existed`,
      );
    }
    return room;
  }
}
