/**
 * The layer that lets more than one backend instance serve the same match.
 *
 * The problem it solves: a live match is stateful and self-driving — dealt
 * hands sit in one process's memory and an AI turn loop runs on a timer. You
 * cannot round-robin requests for it across instances. But you also cannot
 * demand that all four players' browsers land on the same instance; a load
 * balancer will scatter them.
 *
 * So: **one node owns each match, and commands travel to the owner.**
 *
 *   browser ──ws──> node B ──redis request/reply──> node A (owner)
 *                                                     │ applies the move
 *   browser <──ws── node B <──redis fan-out──────────┘ publishes new state
 *
 * `MatchGateway` is that arrow. Every entry point below either runs against the
 * local `MatchManager` (when this node owns the match) or is forwarded to
 * whichever node does — and the caller cannot tell which happened.
 *
 * Fan-out is per-match rather than one global firehose, so a node only receives
 * traffic for matches it actually has sockets watching. The owner masks the
 * state once per seat and publishes all the views together; every node then
 * delivers the right view to its own sockets without ever seeing another
 * player's cards for a match it does not own.
 *
 * With no Redis configured this whole file still runs — against a
 * `LocalEventBus` and `LocalOwnershipRegistry`, where "the owner" is always us
 * and every forward is a no-op. That keeps one code path in dev and prod
 * instead of two that drift.
 */

import { randomUUID } from 'node:crypto';
import type { BotLevel, MaskedGameState, RoomState, SeatIndex } from '@hcg/shared';
import type { MatchManager } from '../match/match-manager.js';
import type { EventBus } from './event-bus.js';
import { RemoteError, RequestTimeoutError } from './event-bus.js';
import type { OwnershipRegistry } from './ownership-registry.js';
import type { MatchRepository } from '../persistence/match-repository.js';
import { MatchNotFoundError, MatchUnavailableError, NotHostError, SeatTakenError } from '../errors.js';
import type { Viewer } from '../obfuscation/fog-of-war.js';

export type JoinResult =
  | { readonly kind: 'ROOM'; readonly room: RoomState }
  | { readonly kind: 'MATCH'; readonly state: MaskedGameState };

/** A live socket, as far as the owning node needs to know about it. */
export interface PresenceEntry {
  readonly userId: string;
  readonly token: string;
}

interface SeatPresence {
  readonly seat: SeatIndex;
  readonly userId: string;
  readonly token: string;
  readonly nodeId: string;
}

// ---- Wire commands ----------------------------------------------------------

type Command =
  | { readonly kind: 'ENTER_ROOM'; readonly matchId: string }
  | {
      readonly kind: 'JOIN';
      readonly matchId: string;
      readonly seat: SeatIndex;
      readonly userId: string;
      readonly displayName: string;
      readonly token: string;
      readonly nodeId: string;
    }
  | {
      readonly kind: 'START';
      readonly matchId: string;
      readonly userId: string;
      readonly connectedSeats: readonly SeatPresence[];
      readonly botLevel?: BotLevel;
    }
  | { readonly kind: 'MOVE'; readonly matchId: string; readonly seat: SeatIndex; readonly moveId: string; readonly userId: string }
  | { readonly kind: 'DISCONNECT'; readonly matchId: string; readonly userId: string; readonly token: string }
  | {
      readonly kind: 'SYNC_PRESENCE';
      readonly matchId: string;
      readonly nodeId: string;
      readonly connections: readonly PresenceEntry[];
    }
  | { readonly kind: 'STATE'; readonly matchId: string; readonly seat: Viewer };

/** What the owner publishes after any change, ready for every node to deliver. */
export type Fanout =
  | { readonly kind: 'ROOM'; readonly matchId: string; readonly room: RoomState }
  | {
      readonly kind: 'STATE';
      readonly matchId: string;
      /** One masked view per seat, indexed by seat number. */
      readonly bySeat: readonly MaskedGameState[];
      /** The view for a watcher holding no seat — someone who entered the room but never sat down. */
      readonly spectator: MaskedGameState;
    };

export type FanoutListener = (fanout: Fanout) => void;

// ---- Error transport --------------------------------------------------------

/**
 * Errors cross the bus as `{name, message}` and come back as `RemoteError`.
 * Rebuilding the original class matters because the WebSocket layer branches
 * on it to pick an error code the client can act on (`SEAT_TAKEN` offers
 * another seat; `NOT_HOST` does not).
 */
function rehydrate(err: unknown): Error {
  if (!(err instanceof RemoteError)) return err instanceof Error ? err : new Error(String(err));
  switch (err.remoteName) {
    case 'SeatTakenError':
      return new SeatTakenError(-1, err.message);
    case 'NotHostError':
      return new NotHostError(err.message);
    case 'MatchNotFoundError':
      return new MatchNotFoundError('', err.message);
    case 'MatchUnavailableError':
      return new MatchUnavailableError('', err.message);
    default:
      return new Error(err.message);
  }
}

export interface MatchGatewayOptions {
  readonly manager: MatchManager;
  readonly bus: EventBus;
  readonly registry: OwnershipRegistry;
  /** Durable store, consulted to recover a match whose owning node died. */
  readonly repository: MatchRepository;
  /** Stable identity for this process. Defaults to a fresh UUID per boot. */
  readonly nodeId?: string;
  /** Ownership lease length. Renewed at a third of this. Default 30s. */
  readonly leaseTtlMs?: number;
  /** How often each node re-asserts its connections to the owner. Default 10s. */
  readonly presenceIntervalMs?: number;
  /** How quiet a node must go before the owner forgets its connections. Default 35s. */
  readonly presenceTtlMs?: number;
  /** Deadline for a forwarded command. Default 5s. */
  readonly requestTimeoutMs?: number;
  /** How long a finished match stays readable before being dropped. Default 5 min. */
  readonly retireAfterMs?: number;
}

export class MatchGateway {
  readonly nodeId: string;
  private readonly manager: MatchManager;
  private readonly bus: EventBus;
  private readonly registry: OwnershipRegistry;
  private readonly repository: MatchRepository;
  private readonly leaseTtlMs: number;
  private readonly presenceIntervalMs: number;
  private readonly presenceTtlMs: number;
  private readonly requestTimeoutMs: number;
  private readonly retireAfterMs: number;

  /** Matches this node currently owns and is therefore renewing a lease on. */
  private readonly owned = new Set<string>();
  /** Local sockets' presence per match, re-asserted to the owner on a timer. */
  private readonly localPresence = new Map<string, Map<string, PresenceEntry>>();
  /** Fan-out subscriptions, ref-counted so the last socket to leave unsubscribes. */
  private readonly watches = new Map<string, { listeners: Set<FanoutListener>; unsubscribe: () => void }>();
  /** Serialises recovery so four simultaneous reconnects don't adopt a match four times. */
  private readonly recoveries = new Map<string, Promise<boolean>>();
  /** Finished matches waiting out their read-only grace period before being dropped. */
  private readonly retiring = new Map<string, NodeJS.Timeout>();

  private timers: NodeJS.Timeout[] = [];
  private commandUnsubscribe: (() => void) | null = null;
  private closed = false;

  constructor(opts: MatchGatewayOptions) {
    this.nodeId = opts.nodeId ?? randomUUID();
    this.manager = opts.manager;
    this.bus = opts.bus;
    this.registry = opts.registry;
    this.repository = opts.repository;
    this.leaseTtlMs = opts.leaseTtlMs ?? 30_000;
    this.presenceIntervalMs = opts.presenceIntervalMs ?? 10_000;
    this.presenceTtlMs = opts.presenceTtlMs ?? 35_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 5_000;
    this.retireAfterMs = opts.retireAfterMs ?? 5 * 60_000;
  }

  /** Subscribes this node's command inbox and starts the lease/presence timers. */
  async start(): Promise<void> {
    this.commandUnsubscribe = await this.bus.handleRequests(this.commandChannel(this.nodeId), (payload) =>
      this.execute(payload as Command),
    );

    // Any state change on a match we own becomes a fan-out to every node.
    this.manager.onChange((matchId) => {
      void this.publishFanout(matchId).catch((err: unknown) => {
        console.error(`[gateway] fan-out failed for match "${matchId}":`, err);
      });
    });

    this.timers.push(interval(() => void this.renewLeases(), Math.max(1_000, Math.floor(this.leaseTtlMs / 3))));
    this.timers.push(interval(() => void this.pushPresence(), this.presenceIntervalMs));
  }

  private commandChannel(nodeId: string): string {
    return `node:${nodeId}:cmd`;
  }

  private fanoutChannel(matchId: string): string {
    return `match:${matchId}`;
  }

  // ---- Routing -------------------------------------------------------------

  /**
   * Resolves who should handle `matchId` and either runs `local` here or ships
   * `command` to the owner. Recovery from a dead owner happens here too, once,
   * behind a per-match promise.
   */
  private async route<T>(matchId: string, command: Command): Promise<T> {
    if (this.owned.has(matchId)) return (await this.execute(command)) as T;

    let owner = await this.registry.owner(matchId).catch(() => null);

    if (owner === null) {
      // Nobody holds it. Either we have it in memory and simply lost the lease
      // (Redis blip) — reclaim — or the owner died and we recover from disk.
      if (await this.recover(matchId)) return (await this.execute(command)) as T;
      owner = await this.registry.owner(matchId).catch(() => null);
      if (owner === null) throw new MatchNotFoundError(matchId);
    }

    if (owner === this.nodeId) {
      this.owned.add(matchId);
      return (await this.execute(command)) as T;
    }

    try {
      return await this.bus.request<T>(this.commandChannel(owner), command, this.requestTimeoutMs);
    } catch (err) {
      if (err instanceof RequestTimeoutError) {
        // The owner is gone or wedged. Let its lease lapse and let the next
        // attempt recover the match rather than pretending it never existed.
        throw new MatchUnavailableError(matchId);
      }
      throw rehydrate(err);
    }
  }

  /**
   * Takes ownership of an orphaned match, rebuilding it from the durable
   * snapshot. Returns false when there is nothing to recover.
   */
  private recover(matchId: string): Promise<boolean> {
    const inFlight = this.recoveries.get(matchId);
    if (inFlight) return inFlight;

    const attempt = (async (): Promise<boolean> => {
      // We may still hold the match in memory — a lease that lapsed during a
      // Redis outage, not a lost node. Reclaiming is then free.
      const holdsLocally = this.manager.allMatchIds().includes(matchId);
      if (holdsLocally) {
        const winner = await this.registry.claim(matchId, this.nodeId, this.leaseTtlMs).catch(() => this.nodeId);
        if (winner === this.nodeId) {
          this.owned.add(matchId);
          return true;
        }
        return false;
      }

      const persisted = await this.repository.load(matchId).catch(() => null);
      if (!persisted) return false;

      const winner = await this.registry.claim(matchId, this.nodeId, this.leaseTtlMs).catch(() => this.nodeId);
      if (winner !== this.nodeId) return false; // another node beat us to it; route there instead

      console.warn(`[gateway] recovering match "${matchId}" from snapshot @ seq ${persisted.sequence}`);
      this.manager.adopt(persisted);
      this.owned.add(matchId);
      void this.manager.resume(matchId).catch((err: unknown) => {
        console.error(`[gateway] failed to resume recovered match "${matchId}":`, err);
      });
      return true;
    })().finally(() => this.recoveries.delete(matchId));

    this.recoveries.set(matchId, attempt);
    return attempt;
  }

  /** Runs a command against the local `MatchManager`. Only ever called on the owner. */
  private async execute(command: Command): Promise<unknown> {
    switch (command.kind) {
      case 'ENTER_ROOM':
        return this.manager.getRoomState(command.matchId);

      case 'JOIN': {
        const { matchId, seat, userId, displayName, token, nodeId } = command;
        if (this.manager.isRoom(matchId)) {
          this.manager.claimRoomSeat(matchId, seat, userId, displayName);
          return { kind: 'ROOM', room: this.manager.getRoomState(matchId) } satisfies JoinResult;
        }
        this.manager.claimSeat(matchId, seat, userId);
        this.manager.connect(matchId, userId, token, nodeId);
        return { kind: 'MATCH', state: this.manager.getMaskedState(matchId, seat) } satisfies JoinResult;
      }

      case 'START': {
        const connectedSeats = new Map(
          command.connectedSeats.map((p) => [p.seat, { userId: p.userId, token: p.token, nodeId: p.nodeId }] as const),
        );
        await this.manager.startMatch(command.matchId, command.userId, connectedSeats, command.botLevel);
        return null;
      }

      case 'MOVE':
        await this.manager.submitMove(command.matchId, command.seat, command.moveId, command.userId);
        return null;

      case 'DISCONNECT':
        await this.manager.disconnect(command.matchId, command.userId, command.token);
        return null;

      case 'SYNC_PRESENCE':
        await this.manager.syncNodePresence(command.matchId, command.nodeId, command.connections);
        return null;

      case 'STATE':
        return this.manager.getMaskedState(command.matchId, command.seat);
    }
  }

  // ---- Public API (mirrors MatchManager, but node-transparent) ---------------

  /** Rooms are always created on the node the host is connected to, which then owns them. */
  async createRoom(
    gameId: string,
    hostUserId: string,
    playerCount?: number,
    maxHands?: number,
  ): Promise<string> {
    const matchId = await this.manager.createRoom(gameId, hostUserId, playerCount, maxHands);
    await this.registry.claim(matchId, this.nodeId, this.leaseTtlMs).catch(() => {
      // Redis down: still serve the room from this node. It just isn't
      // reachable from other nodes until Redis is back and the lease lands.
      console.warn(`[gateway] could not register ownership of new room "${matchId}"`);
    });
    this.owned.add(matchId);
    return matchId;
  }

  enterRoom(matchId: string): Promise<RoomState> {
    return this.route<RoomState>(matchId, { kind: 'ENTER_ROOM', matchId });
  }

  join(args: {
    matchId: string;
    seat: SeatIndex;
    userId: string;
    displayName: string;
    token: string;
  }): Promise<JoinResult> {
    return this.route<JoinResult>(args.matchId, { kind: 'JOIN', ...args, nodeId: this.nodeId });
  }

  startMatch(matchId: string, userId: string, connectedSeats: readonly SeatPresence[], botLevel?: BotLevel): Promise<void> {
    return this.route<void>(matchId, { kind: 'START', matchId, userId, connectedSeats, botLevel });
  }

  submitMove(matchId: string, seat: SeatIndex, moveId: string, userId: string): Promise<void> {
    return this.route<void>(matchId, { kind: 'MOVE', matchId, seat, moveId, userId });
  }

  getMaskedState(matchId: string, seat: Viewer): Promise<MaskedGameState> {
    return this.route<MaskedGameState>(matchId, { kind: 'STATE', matchId, seat });
  }

  /** Whether `matchId` is a not-yet-started room, asked of whichever node owns it. */
  async isRoom(matchId: string): Promise<boolean> {
    if (this.owned.has(matchId)) return this.manager.isRoom(matchId);
    try {
      await this.enterRoom(matchId);
      return true;
    } catch (err) {
      if (err instanceof MatchNotFoundError) return false;
      throw err;
    }
  }

  /**
   * Reports a socket closing. Best-effort by design: if the owner is briefly
   * unreachable the periodic presence sync will correct it within a tick, so
   * failing here must not surface as an error to anyone.
   */
  async reportDisconnect(matchId: string, userId: string, token: string): Promise<void> {
    this.localPresence.get(matchId)?.delete(token);
    if (this.localPresence.get(matchId)?.size === 0) this.localPresence.delete(matchId);
    try {
      await this.route<void>(matchId, { kind: 'DISCONNECT', matchId, userId, token });
    } catch (err) {
      if (err instanceof MatchNotFoundError) return; // match already finished
      console.warn(`[gateway] disconnect for match "${matchId}" not delivered: ${(err as Error).message}`);
    }
  }

  /** Records a socket as live on this node so the presence timer keeps asserting it. */
  trackPresence(matchId: string, entry: PresenceEntry): void {
    let byToken = this.localPresence.get(matchId);
    if (!byToken) {
      byToken = new Map();
      this.localPresence.set(matchId, byToken);
    }
    byToken.set(entry.token, entry);
  }

  // ---- Fan-out --------------------------------------------------------------

  /**
   * Delivers every future state change for `matchId` to `listener`, on
   * whichever node owns it. Ref-counted: the bus subscription lives only while
   * at least one local socket is watching.
   */
  async watch(matchId: string, listener: FanoutListener): Promise<() => void> {
    let watch = this.watches.get(matchId);
    if (!watch) {
      const listeners = new Set<FanoutListener>();
      const unsubscribe = await this.bus.subscribe(this.fanoutChannel(matchId), (payload) => {
        for (const l of [...listeners]) l(payload as Fanout);
      });
      watch = { listeners, unsubscribe };
      this.watches.set(matchId, watch);
    }
    watch.listeners.add(listener);

    return () => {
      watch!.listeners.delete(listener);
      if (watch!.listeners.size === 0) {
        watch!.unsubscribe();
        this.watches.delete(matchId);
      }
    };
  }

  /** Masks the current state once per seat and broadcasts it. Owner-only. */
  private async publishFanout(matchId: string): Promise<void> {
    if (!this.owned.has(matchId)) return;

    if (this.manager.isRoom(matchId)) {
      await this.bus.publish(this.fanoutChannel(matchId), {
        kind: 'ROOM',
        matchId,
        room: this.manager.getRoomState(matchId),
      } satisfies Fanout);
      return;
    }

    const seats = this.manager.seatCount(matchId);
    const bySeat: MaskedGameState[] = [];
    for (let seat = 0; seat < seats; seat++) bySeat.push(this.manager.getMaskedState(matchId, seat));
    await this.bus.publish(this.fanoutChannel(matchId), {
      kind: 'STATE',
      matchId,
      bySeat,
      spectator: this.manager.getMaskedState(matchId, 'SPECTATOR'),
    } satisfies Fanout);

    if (this.manager.isFinished(matchId)) this.scheduleRetirement(matchId);
    else if (this.manager.isAbandoned(matchId)) this.releaseAbandoned(matchId);
  }

  /**
   * Releases a match the turn loop has stopped driving because nobody is
   * connected to it — unlike `scheduleRetirement`, there is no grace period
   * to hold state for a result screen, since `MatchManager` already waited
   * out `noHumanTimeoutMs` before flagging it. Evicted immediately so it
   * doesn't sit idle holding a lease.
   */
  private releaseAbandoned(matchId: string): void {
    this.owned.delete(matchId);
    this.manager.evict(matchId);
    void this.registry.release(matchId, this.nodeId).catch(() => undefined);
  }

  /**
   * A finished match still has to be readable for a while: a player reconnecting
   * a few seconds after the final hand should get the result screen, not
   * "match not found". So ownership is held for a grace period and only then
   * released, rather than dropped the instant the last hand scores.
   */
  private scheduleRetirement(matchId: string): void {
    if (this.retiring.has(matchId)) return;
    const timer = setTimeout(() => {
      this.retiring.delete(matchId);
      this.owned.delete(matchId);
      this.manager.evict(matchId);
      void this.registry.release(matchId, this.nodeId).catch(() => undefined);
    }, this.retireAfterMs);
    timer.unref?.();
    this.retiring.set(matchId, timer);
  }

  // ---- Timers ---------------------------------------------------------------

  /**
   * Keeps our leases alive, and lets go of any we have somehow lost — a node
   * that kept driving a match whose lease moved elsewhere would fight the new
   * owner over the same state.
   */
  private async renewLeases(): Promise<void> {
    for (const matchId of [...this.owned]) {
      const stillOurs = await this.registry.renew(matchId, this.nodeId, this.leaseTtlMs).catch(() => true);
      if (stillOurs) continue;

      const owner = await this.registry.owner(matchId).catch(() => null);
      if (owner === null) {
        // The key expired but nobody claimed it — take it straight back.
        const winner = await this.registry.claim(matchId, this.nodeId, this.leaseTtlMs).catch(() => this.nodeId);
        if (winner === this.nodeId) continue;
      }
      console.warn(`[gateway] lost ownership of match "${matchId}" to node ${owner ?? 'unknown'} — releasing it locally`);
      this.owned.delete(matchId);
      this.manager.evict(matchId);
    }

    // Sweep connections belonging to nodes that stopped reporting in.
    for (const matchId of this.manager.liveMatchIds()) {
      if (!this.owned.has(matchId)) continue;
      await this.manager.evictStaleNodes(matchId, this.presenceTtlMs).catch((err: unknown) => {
        console.error(`[gateway] presence sweep failed for "${matchId}":`, err);
      });
    }
  }

  /** Re-asserts this node's sockets to each match's owner. */
  private async pushPresence(): Promise<void> {
    for (const [matchId, byToken] of [...this.localPresence]) {
      if (byToken.size === 0) {
        this.localPresence.delete(matchId);
        continue;
      }
      try {
        await this.route<void>(matchId, {
          kind: 'SYNC_PRESENCE',
          matchId,
          nodeId: this.nodeId,
          connections: [...byToken.values()],
        });
      } catch (err) {
        if (err instanceof MatchNotFoundError) {
          this.localPresence.delete(matchId); // match is over; stop asserting it
          continue;
        }
        // Owner temporarily unreachable — next tick tries again.
      }
    }
  }

  // ---- Shutdown -------------------------------------------------------------

  /**
   * Hands every owned match back before the process exits, so a rolling deploy
   * moves matches to a surviving node immediately instead of stalling players
   * for a full lease TTL.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    for (const timer of this.retiring.values()) clearTimeout(timer);
    this.retiring.clear();
    this.commandUnsubscribe?.();
    this.commandUnsubscribe = null;

    for (const watch of this.watches.values()) watch.unsubscribe();
    this.watches.clear();

    await Promise.allSettled([...this.owned].map((matchId) => this.registry.release(matchId, this.nodeId)));
    this.owned.clear();
    this.localPresence.clear();
  }
}

function interval(fn: () => void, ms: number): NodeJS.Timeout {
  const timer = setInterval(fn, ms);
  // Never let a background timer be the reason the process refuses to exit.
  timer.unref?.();
  return timer;
}
