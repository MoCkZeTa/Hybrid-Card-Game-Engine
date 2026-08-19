import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginManager } from '../plugin/plugin-manager.js';
import { InMemoryPluginRepository } from '../plugin/plugin-repository.js';
import { createRng } from '../engine/deck.js';
import { createMatch } from '../engine/state.js';
import { InMemoryMatchRepository } from './match-repository.js';
import { AsyncPersistenceWriter } from './persist-writer.js';
import type { MatchRepository } from './match-repository.js';

const gamesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'games');

async function sampleState() {
  const plugins = await PluginManager.loadAll(gamesRoot, new InMemoryPluginRepository());
  const plugin = plugins.get('callbreak');
  const state = createMatch({
    rules: plugin.rules,
    gameId: plugin.gameId,
    matchId: 'persist-1',
    playerCount: 4,
    dealerSeat: 0,
    playerNames: ['A', 'B', 'C', 'D'],
    aiSeats: new Set(),
    rng: createRng(1),
  });
  return { plugin, state };
}

describe('InMemoryMatchRepository', () => {
  it('round-trips a save/load', async () => {
    const { plugin, state } = await sampleState();
    const repo = new InMemoryMatchRepository();
    await repo.save(state.matchId, plugin.gameId, 1, state);

    const loaded = await repo.load(state.matchId);
    expect(loaded).not.toBeNull();
    expect(loaded!.sequence).toBe(1);
    expect(loaded!.state.matchId).toBe(state.matchId);
  });

  it('never lets a stale (lower-sequence) write clobber a newer one', async () => {
    const { plugin, state } = await sampleState();
    const repo = new InMemoryMatchRepository();
    const laterState = { ...state, handNumber: 2 };

    await repo.save(state.matchId, plugin.gameId, 5, laterState);
    await repo.save(state.matchId, plugin.gameId, 3, state); // arrives late, out of order

    const loaded = await repo.load(state.matchId);
    expect(loaded!.sequence).toBe(5);
    expect(loaded!.state.handNumber).toBe(2);
  });

  it('returns null for an unknown match and clears on delete', async () => {
    const repo = new InMemoryMatchRepository();
    expect(await repo.load('nope')).toBeNull();

    const { plugin, state } = await sampleState();
    await repo.save(state.matchId, plugin.gameId, 1, state);
    await repo.delete(state.matchId);
    expect(await repo.load(state.matchId)).toBeNull();
  });
});

describe('AsyncPersistenceWriter', () => {
  it('schedule() returns immediately without awaiting the underlying save', async () => {
    const { plugin, state } = await sampleState();
    let resolveSave: () => void = () => {};
    const slowRepo: MatchRepository = {
      save: () => new Promise((resolve) => (resolveSave = resolve)),
      load: async () => null,
      delete: async () => {},
    };
    const writer = new AsyncPersistenceWriter(slowRepo);

    const before = Date.now();
    writer.schedule(state.matchId, plugin.gameId, 1, state);
    const elapsed = Date.now() - before;

    expect(elapsed).toBeLessThan(20); // did not block on the pending save promise
    resolveSave();
  });

  it('routes a failed save to the onError callback instead of throwing', async () => {
    const { plugin, state } = await sampleState();
    const failingRepo: MatchRepository = {
      save: async () => {
        throw new Error('simulated Atlas outage');
      },
      load: async () => null,
      delete: async () => {},
    };
    const onError = vi.fn();
    const writer = new AsyncPersistenceWriter(failingRepo, onError);

    writer.schedule(state.matchId, plugin.gameId, 1, state);
    await new Promise((resolve) => setTimeout(resolve, 10)); // let the microtask/catch settle

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect(onError.mock.calls[0]![1]).toBe(state.matchId);
  });
});
