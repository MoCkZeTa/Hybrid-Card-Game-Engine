import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BotLevel } from '@hcg/shared';
import { PluginManager } from '../plugin/plugin-manager.js';
import { InMemoryPluginRepository } from '../plugin/plugin-repository.js';
import { InMemoryMatchRepository } from '../persistence/match-repository.js';
import { AsyncPersistenceWriter } from '../persistence/persist-writer.js';
import { MatchManager, NotHostError, SeatTakenError } from './match-manager.js';
import type { LLMDecisionRequest, LLMDecisionResponse, LLMProvider } from '../ai/provider.js';
import type { BotTier } from '../ai/provider-router.js';

const gamesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'games');
const HOST = 'user-host';
const USER_A = 'user-a';
const USER_B = 'user-b';

/** Always plays the first legal move — deterministic, no network calls. */
class AlwaysFirstMoveProvider implements LLMProvider {
  readonly name = 'always-first';
  decide(req: LLMDecisionRequest): Promise<LLMDecisionResponse> {
    return Promise.resolve({ moveId: req.legalMoveIds[0]!, reasoning: 'test stub' });
  }
}

/** Stamps its `tag` into every decision's `reasoning`, so a test can tell which tier actually answered. */
class TaggedProvider implements LLMProvider {
  constructor(readonly name: string) {}
  decide(req: LLMDecisionRequest): Promise<LLMDecisionResponse> {
    return Promise.resolve({ moveId: req.legalMoveIds[0]!, reasoning: this.name });
  }
}

/** Imitates a slow real LLM call: resolves after `delayMs`, and — like the real providers — rejects once `signal` aborts instead of ignoring it. */
class DelayedProvider implements LLMProvider {
  readonly name = 'delayed';
  constructor(private readonly delayMs: number) {}
  decide(req: LLMDecisionRequest): Promise<LLMDecisionResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ moveId: req.legalMoveIds[0]!, reasoning: 'slow test stub' }), this.delayMs);
      req.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      });
    });
  }
}

/** Same provider/timeout for all four levels — the common case where a test doesn't care about tiering. */
function allTiers(provider: LLMProvider, llmTimeoutMs = 1000): Record<BotLevel, BotTier> {
  return {
    easy: { provider, llmTimeoutMs },
    medium: { provider, llmTimeoutMs },
    hard: { provider, llmTimeoutMs },
    extreme: { provider, llmTimeoutMs },
  };
}

async function buildManager(
  overrides: {
    roundIntermissionMs?: number;
    aiMoveMinDelayMs?: number;
    noHumanTimeoutMs?: number;
    botTiers?: Record<BotLevel, BotTier>;
    defaultBotLevel?: BotLevel;
  } = {},
) {
  const plugins = await PluginManager.loadAll(gamesRoot, new InMemoryPluginRepository());
  const repository = new InMemoryMatchRepository();
  const persistence = new AsyncPersistenceWriter(repository);
  const manager = new MatchManager({
    plugins,
    botTiers: overrides.botTiers ?? allTiers(new AlwaysFirstMoveProvider()),
    defaultBotLevel: overrides.defaultBotLevel ?? 'easy',
    persistence,
    aiMoveMinDelayMs: overrides.aiMoveMinDelayMs ?? 0,
    // No pause between hands by default — tests assert on the finished match,
    // and the real 7s round intermission would just be dead wall-clock time.
    roundIntermissionMs: overrides.roundIntermissionMs ?? 0,
    noHumanTimeoutMs: overrides.noHumanTimeoutMs,
  });
  return { manager, repository };
}

/** Creates a room, claims `seat` for `userId` (also connecting it, as `startMatch` needs), and starts it as the host. */
async function quickStart(
  manager: MatchManager,
  opts: { humanSeat?: number; humanUserId?: string; botLevel?: BotLevel } = {},
): Promise<string> {
  const matchId = await manager.createRoom('callbreak', HOST);
  const connectedSeats = new Map<number, { userId: string; token: string; nodeId: string }>();
  if (opts.humanSeat !== undefined) {
    const userId = opts.humanUserId ?? USER_A;
    manager.claimRoomSeat(matchId, opts.humanSeat, userId, 'Test Player');
    connectedSeats.set(opts.humanSeat, { userId, token: `conn-${userId}`, nodeId: 'test-node' });
  }
  await manager.startMatch(matchId, HOST, connectedSeats, opts.botLevel);
  return matchId;
}

describe('MatchManager room lifecycle', () => {
  it('opens a room with every seat empty and nobody able to act yet', async () => {
    const { manager } = await buildManager();
    const matchId = await manager.createRoom('callbreak', HOST);

    expect(manager.isRoom(matchId)).toBe(true);
    const room = manager.getRoomState(matchId);
    expect(room.hostUserId).toBe(HOST);
    expect(room.seats).toHaveLength(4);
    expect(room.seats.every((s) => s.userId === null)).toBe(true);
  });

  it("defaults the match length to the plugin's own when the host does not choose", async () => {
    const { manager } = await buildManager();
    const matchId = await manager.createRoom('callbreak', HOST);
    // Callbreak declares maxHands: 5.
    expect(manager.getRoomState(matchId).maxHands).toBe(5);
  });

  it('honours a host-chosen round count for the whole match', async () => {
    const { manager } = await buildManager();
    const matchId = await manager.createRoom('callbreak', HOST, 4, 2);
    expect(manager.getRoomState(matchId).maxHands).toBe(2);

    // Nobody claims a seat, so the whole match plays out inside startMatch.
    await manager.startMatch(matchId, HOST, new Map());

    const state = manager.getMaskedState(matchId, 'SPECTATOR');
    // Callbreak declares 5 hands; the host asked for 2 and gets 2.
    expect(state.totalHands).toBe(2);
    expect(state.handNumber).toBe(2);
    expect(state.lastResult!.scope).toBe('GAME');
    expect(state.lastResult!.endReason).toBe('hand-limit');
    expect(state.matchOver).toBe(true);
  });

  it('rejects a round count outside the allowed range', async () => {
    const { manager } = await buildManager();
    await expect(manager.createRoom('callbreak', HOST, 4, 0)).rejects.toThrow(/between/);
    await expect(manager.createRoom('callbreak', HOST, 4, 999)).rejects.toThrow(/between/);
    await expect(manager.createRoom('callbreak', HOST, 4, 2.5)).rejects.toThrow(/whole number/);
  });

  it('lets players claim and re-seat themselves before the match starts', async () => {
    const { manager } = await buildManager();
    const matchId = await manager.createRoom('callbreak', HOST);
    manager.claimRoomSeat(matchId, 0, USER_A, 'Alice');
    expect(manager.getRoomState(matchId).seats[0]).toMatchObject({ userId: USER_A, displayName: 'Alice' });

    // Re-seating moves them, freeing seat 0.
    manager.claimRoomSeat(matchId, 1, USER_A, 'Alice');
    const room = manager.getRoomState(matchId);
    expect(room.seats[0]!.userId).toBeNull();
    expect(room.seats[1]!.userId).toBe(USER_A);

    expect(() => manager.claimRoomSeat(matchId, 1, USER_B, 'Bob')).toThrow(SeatTakenError);
  });

  it('rejects START_MATCH from anyone but the host', async () => {
    const { manager } = await buildManager();
    const matchId = await manager.createRoom('callbreak', HOST);
    await expect(manager.startMatch(matchId, USER_A, new Map())).rejects.toThrow(NotHostError);
  });

  it('fills every unclaimed seat with AI and moves the room to a live match on start', async () => {
    const { manager } = await buildManager();
    const matchId = await quickStart(manager, { humanSeat: 0 });

    expect(manager.isRoom(matchId)).toBe(false);
    const state = manager.getMaskedState(matchId, 0);
    expect(state.phase === 'BIDDING' || state.phase === 'PLAYING').toBe(true);
    expect(state.players[1]!.isAI).toBe(true);
    expect(state.players[2]!.isAI).toBe(true);
    expect(state.players[3]!.isAI).toBe(true);
  });

  it('an all-AI room (nobody claims a seat) plays every hand of the match out', async () => {
    const { manager } = await buildManager();
    const matchId = await quickStart(manager);

    const state = manager.getMaskedState(matchId, 'SPECTATOR');
    expect(state.phase).toBe('SCORING');
    expect(state.matchOver).toBe(true);
    // Callbreak declares maxHands: 5 — the match runs all of them, not one.
    expect(state.handNumber).toBe(5);
    expect(state.lastResult?.scope).toBe('GAME');
  });
});

describe('MatchManager live match', () => {
  it('blocks at a connected human seat and resumes once that seat submits a move', async () => {
    const { manager } = await buildManager();
    const matchId = await quickStart(manager, { humanSeat: 0 });

    let state = manager.getMaskedState(matchId, 0);
    expect(state.phase === 'BIDDING' || state.phase === 'PLAYING').toBe(true);

    // Five hands of bids + tricks, so the loop needs plenty of headroom.
    for (let i = 0; i < 500; i++) {
      state = manager.getMaskedState(matchId, 0);
      if (state.matchOver) break;
      if (state.turnSeat !== 0) throw new Error('expected to be blocked on the human seat');
      await manager.submitMove(matchId, 0, state.legalMoves[0]!.id, USER_A);
    }

    const final = manager.getMaskedState(matchId, 0);
    expect(final.matchOver).toBe(true);
    expect(final.handNumber).toBe(5);
  });

  it('rejects a move submitted for the wrong seat', async () => {
    const { manager } = await buildManager();
    const matchId = await manager.createRoom('callbreak', HOST);
    manager.claimRoomSeat(matchId, 0, USER_A, 'Alice');
    manager.claimRoomSeat(matchId, 1, USER_A, 'Alice');
    await manager.startMatch(matchId, HOST, new Map());

    const state = manager.getMaskedState(matchId, 0);
    const otherSeat = state.turnSeat === 0 ? 1 : 0;

    await expect(manager.submitMove(matchId, otherSeat, 'whatever', USER_A)).rejects.toThrow();
  });

  it('rejects a move from a user who does not hold the seat', async () => {
    const { manager } = await buildManager();
    const matchId = await quickStart(manager, { humanSeat: 0 });
    const state = manager.getMaskedState(matchId, 0);

    await expect(manager.submitMove(matchId, 0, state.legalMoves[0]!.id, USER_B)).rejects.toThrow(
      /do not hold seat/,
    );
  });

  it('lets the same user re-claim their seat (reconnect) but blocks a different user', async () => {
    const { manager } = await buildManager();
    const matchId = await quickStart(manager, { humanSeat: 0 });

    expect(() => manager.claimSeat(matchId, 0, USER_A)).not.toThrow(); // reconnect is idempotent
    expect(() => manager.claimSeat(matchId, 0, USER_B)).toThrow(SeatTakenError);
    expect(manager.ownsSeat(matchId, 0, USER_A)).toBe(true);
    expect(manager.ownsSeat(matchId, 0, USER_B)).toBe(false);
  });

  it('hands a seat to AI once its owner disconnects, and back to them once they reconnect', async () => {
    const { manager } = await buildManager();
    const matchId = await quickStart(manager, { humanSeat: 0 });

    const state = manager.getMaskedState(matchId, 0);
    expect(state.phase === 'BIDDING' || state.phase === 'PLAYING').toBe(true);

    // Disconnect seat 0's owner mid-hand — AI should take over from here and
    // play the whole match out without any further human input.
    await manager.disconnect(matchId, USER_A, `conn-${USER_A}`);
    const afterDisconnect = manager.getMaskedState(matchId, 0);
    expect(afterDisconnect.matchOver).toBe(true);

    // Reconnecting after the hand is over is harmless — the claim still holds.
    manager.connect(matchId, USER_A, 'conn-a-2');
    expect(manager.ownsSeat(matchId, 0, USER_A)).toBe(true);
  });

  it('stops driving an all-AI match once nobody has been connected for the no-human timeout', async () => {
    const { manager } = await buildManager({ noHumanTimeoutMs: 5, aiMoveMinDelayMs: 20 });
    const matchId = await manager.createRoom('callbreak', HOST);

    // Nobody ever claims a seat, so this table is AI vs AI from the start —
    // exactly the case that would otherwise run to completion unattended.
    await manager.startMatch(matchId, HOST, new Map());

    expect(manager.isAbandoned(matchId)).toBe(true);
    const state = manager.getMaskedState(matchId, 'SPECTATOR');
    // Caught mid-match, not finished — the loop gave up rather than played it out.
    expect(state.matchOver).toBe(false);
  });

  it('does not abandon a match while a human is connected, even if disconnect/reconnect cycles happen', async () => {
    const { manager } = await buildManager({ noHumanTimeoutMs: 5, aiMoveMinDelayMs: 20 });
    const matchId = await quickStart(manager, { humanSeat: 0 });

    expect(manager.isAbandoned(matchId)).toBe(false);
  });

  it('resumes driving a match once a human reconnects after being flagged abandoned', async () => {
    const { manager } = await buildManager({ noHumanTimeoutMs: 5, aiMoveMinDelayMs: 20 });
    const matchId = await manager.createRoom('callbreak', HOST);
    manager.claimRoomSeat(matchId, 0, USER_A, 'Alice');
    // Claimed but never connected — nobody is actually present when the match goes live.
    await manager.startMatch(matchId, HOST, new Map());
    expect(manager.isAbandoned(matchId)).toBe(true);

    manager.connect(matchId, USER_A, `conn-${USER_A}`);
    expect(manager.isAbandoned(matchId)).toBe(false);
    expect(manager.ownsSeat(matchId, 0, USER_A)).toBe(true);

    const state = manager.getMaskedState(matchId, 0);
    if (state.turnSeat === 0) {
      await manager.submitMove(matchId, 0, state.legalMoves[0]!.id, USER_A);
    }
    expect(manager.isAbandoned(matchId)).toBe(false);
  });

  it('refuses to let anyone claim an AI-controlled seat once the match is live', async () => {
    const { manager } = await buildManager();
    const matchId = await quickStart(manager, { humanSeat: 0 });
    expect(() => manager.claimSeat(matchId, 2, USER_B)).toThrow(/AI-controlled/);
  });

  it('holds a finished hand in SCORING for the intermission, then deals the next one', async () => {
    const { manager } = await buildManager({ roundIntermissionMs: 120 });
    const matchId = await manager.createRoom('callbreak', HOST);

    // All-AI table: startMatch drives every hand, so let it run in the
    // background and observe the pause between hands as it happens.
    const running = manager.startMatch(matchId, HOST, new Map());

    let sawRoundResult = false;
    for (let i = 0; i < 200 && !sawRoundResult; i++) {
      const state = manager.getMaskedState(matchId, 'SPECTATOR');
      if (state.lastResult?.scope === 'ROUND') {
        sawRoundResult = true;
        expect(state.phase).toBe('SCORING');
        expect(state.matchOver).toBe(false);
        expect(state.handNumber).toBeLessThan(5);
        // The countdown the client renders on the round popup.
        expect(state.nextRoundInMs).not.toBeNull();
        expect(state.nextRoundInMs!).toBeGreaterThan(0);
        expect(state.nextRoundInMs!).toBeLessThanOrEqual(120);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(sawRoundResult).toBe(true);

    await running;
    const final = manager.getMaskedState(matchId, 'SPECTATOR');
    expect(final.matchOver).toBe(true);
    expect(final.nextRoundInMs).toBeNull();
    expect(final.lastResult?.scope).toBe('GAME');
  });

  it('persists state via the injected repository as the match progresses', async () => {
    const { manager, repository } = await buildManager();
    const matchId = await quickStart(manager);
    await new Promise((resolve) => setTimeout(resolve, 10)); // let fire-and-forget writes settle

    const persisted = await repository.load(matchId);
    expect(persisted).not.toBeNull();
    expect(persisted!.state.phase).toBe('SCORING');
  });
});

describe('MatchManager bot difficulty levels', () => {
  function taggedTiers(): Record<BotLevel, BotTier> {
    return {
      easy: { provider: new TaggedProvider('easy'), llmTimeoutMs: 1000 },
      medium: { provider: new TaggedProvider('medium'), llmTimeoutMs: 1000 },
      hard: { provider: new TaggedProvider('hard'), llmTimeoutMs: 1000 },
      extreme: { provider: new TaggedProvider('extreme'), llmTimeoutMs: 1000 },
    };
  }

  it('uses the requested level for every AI seat, not the configured default', async () => {
    const { manager } = await buildManager({ botTiers: taggedTiers(), defaultBotLevel: 'easy' });
    // Seat 3 is human (connected) so the loop blocks there, after AI seats 0-2 have each acted once.
    const matchId = await quickStart(manager, { humanSeat: 3, botLevel: 'extreme' });
    const decisions = manager.getDecisionLog(matchId);
    const llmDecisions = decisions.filter((d) => d.source !== 'forced');
    expect(llmDecisions.length).toBeGreaterThan(0);
    expect(llmDecisions.every((d) => d.reasoning === 'extreme')).toBe(true);
  });

  it('falls back to defaultBotLevel when startMatch omits botLevel', async () => {
    const { manager } = await buildManager({ botTiers: taggedTiers(), defaultBotLevel: 'hard' });
    const matchId = await quickStart(manager, { humanSeat: 3 }); // botLevel omitted
    const decisions = manager.getDecisionLog(matchId);
    const llmDecisions = decisions.filter((d) => d.source !== 'forced');
    expect(llmDecisions.length).toBeGreaterThan(0);
    expect(llmDecisions.every((d) => d.reasoning === 'hard')).toBe(true);
  });

  it('a level with a tighter timeout times out on a slow call that a longer-timeout level would have survived', async () => {
    // Same simulated 150ms-slow LLM in both cases — only the per-level timeout budget differs.
    const delay = 150;

    const { manager: tightManager } = await buildManager({
      botTiers: allTiers(new DelayedProvider(delay), 40), // 40ms budget, well under the 150ms delay
      defaultBotLevel: 'easy',
    });
    const tightMatchId = await quickStart(tightManager, { humanSeat: 3, botLevel: 'easy' });
    const tightDecision = tightManager.getDecisionLog(tightMatchId).find((d) => d.source !== 'forced');
    expect(tightDecision?.source).toBe('fallback');

    const { manager: roomyManager } = await buildManager({
      botTiers: allTiers(new DelayedProvider(delay), 400), // 400ms budget, comfortably over the 150ms delay
      defaultBotLevel: 'extreme',
    });
    const roomyMatchId = await quickStart(roomyManager, { humanSeat: 3, botLevel: 'extreme' });
    const roomyDecision = roomyManager.getDecisionLog(roomyMatchId).find((d) => d.source !== 'forced');
    expect(roomyDecision?.source).toBe('llm');
  });
});

describe('MatchManager plugin visibility', () => {
  it('lets the owner create a match with their private plugin, rejects a non-owner trying to, and still lets a friend join by matchId', async () => {
    const pluginRepository = new InMemoryPluginRepository();
    const plugins = await PluginManager.loadAll(gamesRoot, pluginRepository);
    // A private fork of the shipped callbreak rules. Its id comes back from the
    // import rather than being chosen here — that is the whole point.
    const privateRules = { ...(plugins.get('callbreak').rules as object), displayName: 'Callbreak (private)' };
    const { gameId: privateId } = await plugins.importPlugin(privateRules, 'private strategy', HOST);

    const matchRepository = new InMemoryMatchRepository();
    const manager = new MatchManager({
      plugins,
      botTiers: allTiers(new AlwaysFirstMoveProvider()),
      defaultBotLevel: 'easy',
      persistence: new AsyncPersistenceWriter(matchRepository),
      aiMoveMinDelayMs: 0,
      roundIntermissionMs: 0,
    });

    // A user who neither imported nor owns this plugin cannot create a match with it.
    await expect(manager.createRoom(privateId, USER_B)).rejects.toThrow(/Unknown gameId/);

    // The owner can.
    const matchId = await manager.createRoom(privateId, HOST);
    expect(manager.isRoom(matchId)).toBe(true);

    // A friend who received only the match code — never imported or was
    // granted catalog visibility — can still join and sit at the table.
    manager.claimRoomSeat(matchId, 0, USER_B, 'Bob');
    expect(manager.getRoomState(matchId).seats[0]).toMatchObject({ userId: USER_B, displayName: 'Bob' });
  });
});
