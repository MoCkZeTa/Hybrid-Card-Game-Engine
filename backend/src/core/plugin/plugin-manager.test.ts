import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginManager, PluginLoadError } from './plugin-manager.js';
import { InMemoryPluginRepository } from './plugin-repository.js';

const gamesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'games');

describe('PluginManager', () => {
  it('loads all games under src/games without error', async () => {
    const manager = await PluginManager.loadAll(gamesRoot, new InMemoryPluginRepository());
    expect(manager.has('29')).toBe(true);
    expect(manager.has('callbreak')).toBe(true);
  });

  it('exposes the parsed rules and raw strategy text', async () => {
    const manager = await PluginManager.loadAll(gamesRoot, new InMemoryPluginRepository());
    const twentyNine = manager.get('29');
    expect(twentyNine.rules.trump.mode).toBe('hidden');
    expect(twentyNine.strategy).toContain('Strategic Guide');

    const callbreak = manager.get('callbreak');
    expect(callbreak.rules.trump.mode).toBe('static');
    expect(callbreak.rules.trump.staticSuit).toBe('S');
  });

  it('throws PluginLoadError for a plugin with invalid rules.json', async () => {
    const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'bad-games');
    await expect(PluginManager.loadAll(fixtureRoot, new InMemoryPluginRepository())).rejects.toThrow(PluginLoadError);
  });
});
