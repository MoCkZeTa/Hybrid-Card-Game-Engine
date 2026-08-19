/**
 * Two `MatchGateway`s sharing one backplane and one ownership registry are a
 * faithful stand-in for two backend instances sharing one Redis: the routing,
 * fan-out, presence, and recovery code paths exercised here are the exact ones
 * that run in a clustered deployment, with only the transport swapped.
 */

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HIDDEN_CARD, type BotLevel, type MaskedGameState, type RoomState } from '@hcg/shared';
import { PluginManager } from '../plugin/plugin-manager.js';
import { InMemoryPluginRepository } from '../plugin/plugin-repository.js';
import { InMemoryMatchRepository } from '../persistence/match-repository.js';
import { AsyncPersistenceWriter } from '../persistence/persist-writer.js';
import { MatchManager } from '../match/match-manager.js';
import type { LLMDecisionRequest, LLMDecisionResponse, LLMProvider } from '../ai/provider.js';
import { LocalBusBackplane, LocalEventBus } from './event-bus.js';
import { LocalOwnershipRegistry } from './ownership-registry.js';
import { MatchGateway, type Fanout } from './match-gateway.js';
import { MatchNotFoundError, SeatTakenError } from '../errors.js';

const gamesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'games');
const HOST = 'user-host';
const FRIEND = 'user-friend';

class AlwaysFirstMoveProvider implements LLMProvider {
  readonly name = 'always-first';
  decide(req: LLMDecisionRequest): Promise<LLMDecisionResponse> {
    return Promise.resolve({ moveId: req.legalMoveIds[0]!, reasoning: 'test stub' });
  }
}

function allTiers(provider: LLMProvider, llmTimeoutMs = 1000) {
  return {
    easy: { provider, llmTimeoutMs },
    medium: { provider, llmTimeoutMs },
    hard: { provider, llmTimeoutMs },
    extreme: { provider, llmTimeoutMs },
  } as const satisfies Record<BotLevel, { provider: LLMProvider; llmTimeoutMs: number }>;
}

interface Node {
  readonly gateway: MatchGateway;
  readonly manager: MatchManager;
}

/** Builds `count` nodes wired to one shared bus, registry, and durable store. */
async function cluster(count: number): Promise<{ nodes: Node[]; repository: InMemoryMatchRepository }> {
  const plugins = await PluginManager.loadAll(gamesRoot, new InMemoryPluginRepository());
  const repository = new InMemoryMatchRepository();
  const backplane = new LocalBusBackplane();
  const registry = new LocalOwnershipRegistry();

  const nodes: Node[] = [];
  for (let i = 0; i < count; i++) {
    const manager = new MatchManager({
      plugins,
      botTiers: allTiers(new AlwaysFirstMoveProvider()),
      defaultBotLevel: 'easy',
      persistence: new AsyncPersistenceWriter(repository),
      aiMoveMinDelayMs: 0,
      roundIntermissionMs: 0,
    });
    const gateway = new MatchGateway({
      manager,
      bus: new LocalEventBus(backplane),
      registry,
      repository,
      nodeId: `node-${i}`,
      leaseTtlMs: 60_000,
    });
    await gateway.start();
    nodes.push({ gateway, manager });
  }
  return { nodes, repository };
}

describe('MatchGateway cross-node routing', () => {
  it('lets a player on one node join a room created on another', async () => {
    const { nodes } = await cluster(2);
    const [host, friend] = nodes as [Node, Node];

    const matchId = await host.gateway.createRoom('callbreak', HOST);
    const room = await friend.gateway.enterRoom(matchId);

    expect(room.matchId).toBe(matchId);
    expect(room.seats.every((s) => s.userId === null)).toBe(true);

    const result = await friend.gateway.join({
      matchId,
      seat: 1,
      userId: FRIEND,
      displayName: 'Friend',
      token: 'conn-friend',
    });

    expect(result.kind).toBe('ROOM');
    // The room lives on the host's node, so that is where the claim landed.
    expect(host.manager.getRoomState(matchId).seats[1]?.userId).toBe(FRIEND);
  });

  it('fans a room update out to watchers on every node', async () => {
    const { nodes } = await cluster(2);
    const [host, friend] = nodes as [Node, Node];
    const matchId = await host.gateway.createRoom('callbreak', HOST);

    const seen: Fanout[] = [];
    await friend.gateway.watch(matchId, (f) => seen.push(f));

    await host.gateway.join({ matchId, seat: 0, userId: HOST, displayName: 'Host', token: 'c-host' });
    await tick();

    const rooms = seen.filter((f): f is Extract<Fanout, { kind: 'ROOM' }> => f.kind === 'ROOM');
    expect(rooms.length).toBeGreaterThan(0);
    expect((rooms.at(-1) as { room: RoomState }).room.seats[0]?.userId).toBe(HOST);
  });

  it('routes a move made on one node into the match running on another, and fans the result back', async () => {
    const { nodes } = await cluster(2);
    const [owner, other] = nodes as [Node, Node];

    const matchId = await owner.gateway.createRoom('callbreak', HOST);
    await other.gateway.join({ matchId, seat: 0, userId: HOST, displayName: 'Host', token: 'c-host' });

    const states: MaskedGameState[] = [];
    await other.gateway.watch(matchId, (f) => {
      if (f.kind === 'STATE') states.push(f.bySeat[0]!);
    });

    await owner.gateway.startMatch(matchId, HOST, [
      { seat: 0, userId: HOST, token: 'c-host', nodeId: other.gateway.nodeId },
    ]);
    await tick();

    // The AI has played round to seat 0, which is held by a connected human.
    const current = await other.gateway.getMaskedState(matchId, 0);
    expect(current.turnSeat).toBe(0);
    expect(current.legalMoves.length).toBeGreaterThan(0);

    const before = states.length;
    await other.gateway.submitMove(matchId, 0, current.legalMoves[0]!.id, HOST);
    await tick();

    expect(states.length).toBeGreaterThan(before);
  });

  it('fans out one masked view per seat, so no node ever sees another seat\'s cards', async () => {
    const { nodes } = await cluster(2);
    const [owner, other] = nodes as [Node, Node];

    const matchId = await owner.gateway.createRoom('callbreak', HOST);
    await owner.gateway.join({ matchId, seat: 0, userId: HOST, displayName: 'Host', token: 'c-host' });
    await other.gateway.join({ matchId, seat: 1, userId: FRIEND, displayName: 'Friend', token: 'c-friend' });

    let fanout: Extract<Fanout, { kind: 'STATE' }> | null = null;
    await other.gateway.watch(matchId, (f) => {
      if (f.kind === 'STATE') fanout = f;
    });

    await owner.gateway.startMatch(matchId, HOST, []);
    await tick();

    const state = fanout as Extract<Fanout, { kind: 'STATE' }> | null;
    expect(state).not.toBeNull();
    expect(state!.bySeat).toHaveLength(4);

    // Fog of war survives the trip across the bus: seat 1's view shows its own
    // cards as real ids and everyone else's as masked placeholders.
    const seat1 = state!.bySeat[1]!;
    expect(seat1.viewerSeat).toBe(1);
    const own = seat1.players.find((p) => p.seat === 1)!;
    const opponent = seat1.players.find((p) => p.seat === 0)!;
    expect(own.hand.every((c) => c !== HIDDEN_CARD)).toBe(true);
    expect(opponent.hand.every((c) => c === HIDDEN_CARD)).toBe(true);

    // And a seatless watcher gets a view with no real hands at all.
    expect(state!.spectator.viewerSeat).toBe('SPECTATOR');
    expect(state!.spectator.players.every((p) => p.hand.every((c) => c === HIDDEN_CARD))).toBe(true);
  });

  it('surfaces a remote SeatTaken as the real error class, not a generic one', async () => {
    const { nodes } = await cluster(2);
    const [host, friend] = nodes as [Node, Node];
    const matchId = await host.gateway.createRoom('callbreak', HOST);

    await host.gateway.join({ matchId, seat: 2, userId: HOST, displayName: 'Host', token: 'c-host' });

    await expect(
      friend.gateway.join({ matchId, seat: 2, userId: FRIEND, displayName: 'Friend', token: 'c-friend' }),
    ).rejects.toBeInstanceOf(SeatTakenError);
  });

  it('reports a match no node has ever heard of as not found', async () => {
    const { nodes } = await cluster(2);
    await expect(nodes[1]!.gateway.enterRoom('does-not-exist')).rejects.toBeInstanceOf(MatchNotFoundError);
  });
});

describe('MatchGateway presence across nodes', () => {
  it('lets the owner see a seat as occupied by a human connected through another node', async () => {
    const { nodes } = await cluster(2);
    const [owner, other] = nodes as [Node, Node];

    const matchId = await owner.gateway.createRoom('callbreak', HOST);
    await other.gateway.join({ matchId, seat: 0, userId: HOST, displayName: 'Host', token: 'c-host' });
    await owner.gateway.startMatch(matchId, HOST, [
      { seat: 0, userId: HOST, token: 'c-host', nodeId: other.gateway.nodeId },
    ]);
    await tick();

    // If presence had not crossed the node boundary, the AI would have played
    // seat 0's turn instead of stopping on it.
    expect((await owner.gateway.getMaskedState(matchId, 0)).turnSeat).toBe(0);
  });

  it('hands the seat to the AI once the remote connection reports gone', async () => {
    const { nodes } = await cluster(2);
    const [owner, other] = nodes as [Node, Node];

    const matchId = await owner.gateway.createRoom('callbreak', HOST);
    await other.gateway.join({ matchId, seat: 0, userId: HOST, displayName: 'Host', token: 'c-host' });
    await owner.gateway.startMatch(matchId, HOST, [
      { seat: 0, userId: HOST, token: 'c-host', nodeId: other.gateway.nodeId },
    ]);
    await tick();
    expect((await owner.gateway.getMaskedState(matchId, 0)).turnSeat).toBe(0);

    await other.gateway.reportDisconnect(matchId, HOST, 'c-host');
    await tick();

    // With nobody holding seat 0 any more, play carried on without it.
    const after = await owner.gateway.getMaskedState(matchId, 0);
    expect(after.handNumber).toBeGreaterThanOrEqual(1);
  });

  it('forgets connections from a node that has gone silent, so a crashed node cannot pin a seat', async () => {
    const { nodes } = await cluster(2);
    const [owner, other] = nodes as [Node, Node];

    const matchId = await owner.gateway.createRoom('callbreak', HOST);
    await other.gateway.join({ matchId, seat: 0, userId: HOST, displayName: 'Host', token: 'c-host' });
    await owner.gateway.startMatch(matchId, HOST, [
      { seat: 0, userId: HOST, token: 'c-host', nodeId: other.gateway.nodeId },
    ]);
    await tick();
    expect((await owner.gateway.getMaskedState(matchId, 0)).turnSeat).toBe(0);

    // Node "other" dies: it stops syncing presence, and never sends a close.
    await owner.manager.evictStaleNodes(matchId, 0);
    await tick();

    // With nothing left holding seat 0, the AI took it over and played the
    // match out instead of the table waiting forever on a node that is gone.
    expect(owner.manager.isFinished(matchId)).toBe(true);
  });
});

describe('MatchGateway failover', () => {
  it('adopts a match from its durable snapshot when the owning node is gone', async () => {
    const { nodes, repository } = await cluster(2);
    const [dying, survivor] = nodes as [Node, Node];

    const matchId = await dying.gateway.createRoom('callbreak', HOST);
    await dying.gateway.join({ matchId, seat: 0, userId: HOST, displayName: 'Host', token: 'c-host' });
    await dying.gateway.startMatch(matchId, HOST, [
      { seat: 0, userId: HOST, token: 'c-host', nodeId: dying.gateway.nodeId },
    ]);
    await tick();
    // Persistence is fire-and-forget; let the snapshot land.
    await tick();
    expect(await repository.load(matchId)).not.toBeNull();

    // The node dies: it stops answering, and its lease is released.
    await dying.gateway.close();
    dying.manager.evict(matchId);

    const state = await survivor.gateway.getMaskedState(matchId, 0);

    expect(state.matchId).toBe(matchId);
    // Seat claims are session state and are deliberately not restored — the
    // player has to re-JOIN, which is exactly what a reconnect does.
    expect(survivor.manager.ownsSeat(matchId, 0, HOST)).toBe(false);
  });

  it('lets exactly one node win the race to recover the same match', async () => {
    const { nodes, repository } = await cluster(3);
    const [dying, ...survivors] = nodes as [Node, Node, Node];

    const matchId = await dying.gateway.createRoom('callbreak', HOST);
    await dying.gateway.join({ matchId, seat: 0, userId: HOST, displayName: 'Host', token: 'c-host' });
    // A connected seat leaves the match mid-hand rather than played out — the
    // only case where failover has anything to salvage.
    await dying.gateway.startMatch(matchId, HOST, [
      { seat: 0, userId: HOST, token: 'c-host', nodeId: dying.gateway.nodeId },
    ]);
    await tick();
    expect(await repository.load(matchId)).not.toBeNull();

    await dying.gateway.close();
    dying.manager.evict(matchId);

    // Both survivors try to serve the same reconnecting player at once.
    const results = await Promise.all(survivors.map((n) => n.gateway.getMaskedState(matchId, 0)));

    expect(results.every((s) => s.matchId === matchId)).toBe(true);
    const holders = survivors.filter((n) => n.manager.liveMatchIds().includes(matchId));
    expect(holders).toHaveLength(1);
  });
});

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}
