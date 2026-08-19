import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginManager, PluginImportError, PluginProtectedError } from './plugin-manager.js';
import { InMemoryPluginRepository } from './plugin-repository.js';

const realGamesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'games');

const OWNER = 'owner-user';
const OTHER = 'other-user';

/** Note the absence of a `gameId` — the store assigns identity, the document never claims it. */
const spadesRules = {
  displayName: 'Spades (test)',
  version: '1.0.0',
  players: { min: 4, max: 4, defaultCount: 4, topology: 'fixed-pairs', teamsByCount: { '4': [[0, 2], [1, 3]] } },
  deck: {
    suits: ['S', 'H', 'D', 'C'],
    ranks: ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'],
    deal: { mode: 'fixed', handSize: 13, kittySize: 0 },
    rankOrder: ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'],
    pointValues: {},
  },
  trump: { mode: 'static', staticSuit: 'S' },
  bidding: { enabled: true, minBid: 0, maxBid: 13, allowPass: false, determines: ['trick-quota'] },
  phases: [
    { name: 'DEALING', kind: 'DEALING', next: 'BIDDING' },
    { name: 'BIDDING', kind: 'BIDDING', next: 'PLAYING' },
    { name: 'PLAYING', kind: 'PLAYING', next: 'SCORING' },
    { name: 'SCORING', kind: 'SCORING', next: null },
  ],
  trickRules: { mustFollowSuit: true, mustTrumpIfVoid: false, freeDiscardIfVoidAndNoTrump: true, mustOvertrumpIfPossible: false },
  scoring: { contractBasis: 'tricks' },
};

describe('PluginManager identity assignment', () => {
  let tempRoot: string;

  beforeEach(async () => {
    // Work on a throwaway copy of the real games directory, so that if anything
    // ever did write to disk these tests would corrupt the copy, not the
    // shipped plugin files.
    tempRoot = await mkdtemp(path.join(tmpdir(), 'hcg-plugins-'));
    await cp(realGamesRoot, tempRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('identifies a built-in by its folder name', async () => {
    const manager = await PluginManager.loadAll(tempRoot, new InMemoryPluginRepository());
    expect(manager.has('callbreak')).toBe(true);
    expect(manager.has('29')).toBe(true);
    expect(manager.isBuiltIn('callbreak')).toBe(true);
    expect(manager.get('callbreak').gameId).toBe('callbreak');
  });

  it('imports a valid plugin under a store-assigned id, and it is immediately usable', async () => {
    const repository = new InMemoryPluginRepository();
    const manager = await PluginManager.loadAll(tempRoot, repository);
    const plugin = await manager.importPlugin(spadesRules, '# Spades\n\nLead long suits.', OWNER);

    expect(plugin.imported).toBe(true);
    expect(plugin.ownerUserId).toBe(OWNER);
    // The id came from the repository, not from anything the caller supplied.
    expect(plugin.gameId).toBeTruthy();
    expect(plugin.gameId).not.toBe('spades-test');
    expect(manager.isBuiltIn(plugin.gameId)).toBe(false);
    expect(manager.get(plugin.gameId).rules.trump.staticSuit).toBe('S');

    // Persisted, not just held in memory — a fresh manager sharing the same
    // repository (simulating a restart, or a different node) resolves it via
    // getVisible without needing to re-import.
    const reloaded = await PluginManager.loadAll(tempRoot, repository);
    const fetched = await reloaded.getVisible(plugin.gameId, OWNER);
    expect(fetched.rules.trump.staticSuit).toBe('S');
  });

  it('makes the same rules.json two independent games when imported twice', async () => {
    const manager = await PluginManager.loadAll(tempRoot, new InMemoryPluginRepository());
    const first = await manager.importPlugin(spadesRules, 'v1 strategy', OWNER);
    const second = await manager.importPlugin(spadesRules, 'v2 strategy', OWNER);

    // The old behaviour was a conflict here, because the document named itself.
    expect(second.gameId).not.toBe(first.gameId);
    expect(manager.get(first.gameId).strategy).toBe('v1 strategy');
    expect(manager.get(second.gameId).strategy).toBe('v2 strategy');

    const summaries = await manager.summaries(OWNER);
    expect(summaries.filter((g) => g.displayName === 'Spades (test)')).toHaveLength(2);
  });

  it('rejects a rules.json that still declares a gameId', async () => {
    const manager = await PluginManager.loadAll(tempRoot, new InMemoryPluginRepository());
    await expect(
      manager.importPlugin({ ...spadesRules, gameId: 'spades-test' }, 'strategy', OWNER),
    ).rejects.toThrow(/gameId must not appear in rules.json/);
  });

  it('rejects an invalid rules.json with field-level reasons, and does not register it', async () => {
    const manager = await PluginManager.loadAll(tempRoot, new InMemoryPluginRepository());
    const before = (await manager.summaries(OWNER)).length;
    await expect(manager.importPlugin({ displayName: 'Broken' }, 'strategy text', OWNER)).rejects.toThrow(
      PluginImportError,
    );
    expect(await manager.summaries(OWNER)).toHaveLength(before);
  });

  it('rejects empty strategy text', async () => {
    const manager = await PluginManager.loadAll(tempRoot, new InMemoryPluginRepository());
    await expect(manager.importPlugin(spadesRules, '   ', OWNER)).rejects.toThrow(PluginImportError);
  });
});

describe('PluginManager built-in protection', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'hcg-plugins-'));
    await cp(realGamesRoot, tempRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('refuses to delete a built-in, and it survives a reload', async () => {
    const manager = await PluginManager.loadAll(tempRoot, new InMemoryPluginRepository());
    await expect(manager.deletePlugin('callbreak', OWNER)).rejects.toThrow(PluginProtectedError);
    expect(manager.has('callbreak')).toBe(true);

    // Still on disk: nothing was removed, only refused.
    const reloaded = await PluginManager.loadAll(tempRoot, new InMemoryPluginRepository());
    expect(reloaded.has('callbreak')).toBe(true);
  });

  it('refuses to edit a built-in, leaving its content untouched', async () => {
    const manager = await PluginManager.loadAll(tempRoot, new InMemoryPluginRepository());
    const original = manager.get('callbreak').strategy;

    await expect(
      manager.updatePlugin('callbreak', manager.get('callbreak').rules, 'revised strategy', OWNER),
    ).rejects.toThrow(PluginProtectedError);

    expect(manager.get('callbreak').strategy).toBe(original);
    const reloaded = await PluginManager.loadAll(tempRoot, new InMemoryPluginRepository());
    expect(reloaded.get('callbreak').strategy).toBe(original);
  });

  it('lets a user fork a built-in into their own private copy, leaving the original alone', async () => {
    const manager = await PluginManager.loadAll(tempRoot, new InMemoryPluginRepository());
    const builtIn = manager.get('callbreak');

    const forked = await manager.importPlugin(
      { ...builtIn.rules, displayName: 'Callbreak (my rules)' },
      'my own strategy',
      OWNER,
    );

    expect(forked.gameId).not.toBe('callbreak');
    expect(forked.ownerUserId).toBe(OWNER);
    expect(manager.isBuiltIn(forked.gameId)).toBe(false);
    // The shipped game is untouched.
    expect(manager.get('callbreak').rules.displayName).toBe(builtIn.rules.displayName);
    expect(manager.get('callbreak').ownerUserId).toBeUndefined();
  });
});

describe('PluginManager ownership and visibility', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'hcg-plugins-'));
    await cp(realGamesRoot, tempRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("hides one user's imported plugin from another user's catalog and getVisible lookup", async () => {
    const repository = new InMemoryPluginRepository();
    const manager = await PluginManager.loadAll(tempRoot, repository);
    const { gameId } = await manager.importPlugin(spadesRules, 'strategy', OWNER);

    const ownerSummaries = await manager.summaries(OWNER);
    expect(ownerSummaries.some((g) => g.gameId === gameId)).toBe(true);

    const otherSummaries = await manager.summaries(OTHER);
    expect(otherSummaries.some((g) => g.gameId === gameId)).toBe(false);

    await expect(manager.getVisible(gameId, OTHER)).rejects.toThrow(/Unknown gameId/);
    // The denial must not leak the existence of other private plugins via a registry dump.
    await expect(manager.getVisible(gameId, OTHER)).rejects.not.toThrow(/Registered/);
  });

  it('built-in games remain visible to everyone, including an anonymous (no-userId) request', async () => {
    const manager = await PluginManager.loadAll(tempRoot, new InMemoryPluginRepository());
    const summaries = await manager.summaries();
    expect(summaries.some((g) => g.gameId === 'callbreak')).toBe(true);
    const plugin = await manager.getVisible('callbreak', OTHER);
    expect(plugin.gameId).toBe('callbreak');
  });

  it('lets the owner edit an imported plugin in place, keeping its id', async () => {
    const repository = new InMemoryPluginRepository();
    const manager = await PluginManager.loadAll(tempRoot, repository);
    const { gameId } = await manager.importPlugin(spadesRules, 'v1 strategy', OWNER);

    const updated = await manager.updatePlugin(
      gameId,
      { ...spadesRules, displayName: 'Spades Deluxe' },
      'v2 strategy — now with more nil bids',
      OWNER,
    );
    // The id surviving the edit is what keeps rooms and match records valid.
    expect(updated.gameId).toBe(gameId);
    expect(updated.rules.displayName).toBe('Spades Deluxe');

    const reloaded = await PluginManager.loadAll(tempRoot, repository);
    const fetched = await reloaded.getVisible(gameId, OWNER);
    expect(fetched.rules.displayName).toBe('Spades Deluxe');
    expect(fetched.strategy).toContain('nil bids');
  });

  it('rejects an edit by a non-owner and leaves the plugin untouched', async () => {
    const repository = new InMemoryPluginRepository();
    const manager = await PluginManager.loadAll(tempRoot, repository);
    const { gameId } = await manager.importPlugin(spadesRules, 'v1 strategy', OWNER);

    await expect(manager.updatePlugin(gameId, spadesRules, 'hijacked', OTHER)).rejects.toThrow(PluginImportError);
    const stillOwners = await manager.getVisible(gameId, OWNER);
    expect(stillOwners.strategy).toBe('v1 strategy');
  });

  it('deletes an imported plugin from the registry and the repository', async () => {
    const repository = new InMemoryPluginRepository();
    const manager = await PluginManager.loadAll(tempRoot, repository);
    const { gameId } = await manager.importPlugin(spadesRules, 'strategy text', OWNER);
    expect(manager.has(gameId)).toBe(true);

    await manager.deletePlugin(gameId, OWNER);
    expect(manager.has(gameId)).toBe(false);

    const reloaded = await PluginManager.loadAll(tempRoot, repository);
    await expect(reloaded.getVisible(gameId, OWNER)).rejects.toThrow(/Unknown gameId/);
  });

  it('rejects a delete attempt by a non-owner', async () => {
    const repository = new InMemoryPluginRepository();
    const manager = await PluginManager.loadAll(tempRoot, repository);
    const { gameId } = await manager.importPlugin(spadesRules, 'strategy', OWNER);

    await expect(manager.deletePlugin(gameId, OTHER)).rejects.toThrow();
    expect(manager.has(gameId)).toBe(true);
  });

  it('throws for deleting an unknown gameId', async () => {
    const manager = await PluginManager.loadAll(tempRoot, new InMemoryPluginRepository());
    await expect(manager.deletePlugin('does-not-exist', OWNER)).rejects.toThrow(/Unknown gameId/);
  });

  it('resolves a plugin via the repository alone on a fresh PluginManager that never imported it locally', async () => {
    const repository = new InMemoryPluginRepository();
    const importer = await PluginManager.loadAll(tempRoot, repository);
    const { gameId } = await importer.importPlugin(spadesRules, 'strategy', OWNER);

    // A different PluginManager instance sharing the same repository —
    // simulating a second server node that never saw the import happen.
    const otherNode = await PluginManager.loadAll(tempRoot, repository);
    const plugin = await otherNode.getVisible(gameId, OWNER);
    expect(plugin.rules.displayName).toBe('Spades (test)');
  });
});
