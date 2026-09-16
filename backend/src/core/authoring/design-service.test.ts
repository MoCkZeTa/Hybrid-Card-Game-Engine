/**
 * Session lifecycle, ownership isolation, and the publish path.
 *
 * The publish tests are the important ones: they assert that a drafted game
 * reaches the catalog through `PluginManager` and nowhere else, which is the
 * property that keeps an AI-authored plugin held to exactly the same standard
 * as an uploaded one.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RulesDsl } from '@hcg/shared';
import type { LLMCompletionProvider } from '../ai/provider.js';
import { PluginManager } from '../plugin/plugin-manager.js';
import { InMemoryPluginRepository } from '../plugin/plugin-repository.js';
import { GameDesigner } from './game-designer.js';
import { DesignLimitError, DesignNotFoundError, DesignNotPublishableError, DesignService, MAX_BRIEF_CHARS } from './design-service.js';
import { InMemoryDesignSessionRepository, MAX_SESSIONS_PER_USER } from './design-session-repository.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const gamesRoot = path.join(here, '..', '..', 'games');
const callbreak = JSON.parse(readFileSync(path.join(gamesRoot, 'callbreak', 'rules.json'), 'utf-8')) as RulesDsl;
const strategy = readFileSync(path.join(gamesRoot, 'callbreak', 'strategy.md'), 'utf-8');

const ALICE = 'user-alice';
const BOB = 'user-bob';

/**
 * A provider that renames Callbreak to whatever the brief said, so a test can
 * tell one revision from the next without caring what a real model would say.
 */
class EchoProvider implements LLMCompletionProvider {
  readonly name = 'echo';
  readonly model = 'echo-1';
  calls = 0;
  /** When set, the next response is this raw string instead of a valid draft. */
  nextRaw: string | null = null;

  async complete(request: { userPrompt: string }): Promise<string> {
    this.calls++;
    if (this.nextRaw !== null) {
      const raw = this.nextRaw;
      this.nextRaw = null;
      return raw;
    }
    // The brief is the last line-ish of the prompt; good enough to name a draft.
    const name = request.userPrompt.slice(-40).replace(/\s+/g, ' ').trim();
    return JSON.stringify({
      summary: `Drafted "${name}".`,
      notes: [],
      rules: { ...callbreak, displayName: name || 'Untitled' },
      strategy,
    });
  }
}

async function build() {
  const provider = new EchoProvider();
  const sessions = new InMemoryDesignSessionRepository();
  const pluginRepo = new InMemoryPluginRepository();
  const plugins = await PluginManager.loadAll(gamesRoot, pluginRepo);
  const service = new DesignService(new GameDesigner(provider), sessions, plugins);
  return { provider, sessions, plugins, service };
}

describe('DesignService — sessions', () => {
  let ctx: Awaited<ReturnType<typeof build>>;
  beforeEach(async () => {
    ctx = await build();
  });

  it('creates a session with revision 1 and a title from the drafted game', async () => {
    const session = await ctx.service.createSession(ALICE, 'a spades variant');

    expect(session.revisions).toHaveLength(1);
    expect(session.revisions[0]!.n).toBe(1);
    expect(session.revisions[0]!.prompt).toBe('a spades variant');
    expect(session.revisions[0]!.diagnostics.valid).toBe(true);
    expect(session.title).toContain('a spades variant');
    expect(session.publishedGameId).toBeNull();
  });

  it('leaves no session behind when drafting fails', async () => {
    ctx.provider.nextRaw = 'the model said something unhelpful';
    await expect(ctx.service.createSession(ALICE, 'x')).rejects.toThrow();
    expect(await ctx.service.list(ALICE)).toEqual([]);
  });

  it('refuses an empty or oversized brief before spending a call', async () => {
    await expect(ctx.service.createSession(ALICE, '   ')).rejects.toThrow(DesignLimitError);
    await expect(ctx.service.createSession(ALICE, 'x'.repeat(MAX_BRIEF_CHARS + 1))).rejects.toThrow(DesignLimitError);
    expect(ctx.provider.calls).toBe(0);
  });

  it('appends a revision per refinement and numbers them consecutively', async () => {
    const created = await ctx.service.createSession(ALICE, 'first');
    await ctx.service.refine(created.sessionId, ALICE, 'second');
    const session = await ctx.service.refine(created.sessionId, ALICE, 'third');

    expect(session.revisions.map((r) => r.n)).toEqual([1, 2, 3]);
    expect(session.revisions.map((r) => r.prompt)).toEqual(['first', 'second', 'third']);
  });

  it('caps how many sessions one user can accumulate', async () => {
    const sessions = new InMemoryDesignSessionRepository();
    for (let i = 0; i < MAX_SESSIONS_PER_USER; i++) {
      await sessions.create({
        ownerUserId: ALICE,
        title: `s${i}`,
        revisions: [],
        publishedGameId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    const service = new DesignService(new GameDesigner(ctx.provider), sessions, ctx.plugins);
    await expect(service.createSession(ALICE, 'one more')).rejects.toThrow(DesignLimitError);
  });
});

describe('DesignService — ownership', () => {
  let ctx: Awaited<ReturnType<typeof build>>;
  beforeEach(async () => {
    ctx = await build();
  });

  it("hides another user's session behind the same error as a nonexistent one", async () => {
    const mine = await ctx.service.createSession(ALICE, 'mine');

    // Identical failures: Bob cannot tell a session he may not see from one
    // that was never created.
    await expect(ctx.service.get(mine.sessionId, BOB)).rejects.toThrow(DesignNotFoundError);
    await expect(ctx.service.get('does-not-exist', BOB)).rejects.toThrow(DesignNotFoundError);
    await expect(ctx.service.refine(mine.sessionId, BOB, 'change it')).rejects.toThrow(DesignNotFoundError);
    await expect(ctx.service.delete(mine.sessionId, BOB)).rejects.toThrow(DesignNotFoundError);
    await expect(ctx.service.publish(mine.sessionId, BOB)).rejects.toThrow(DesignNotFoundError);
  });

  it('lists only your own sessions', async () => {
    await ctx.service.createSession(ALICE, 'alice game');
    await ctx.service.createSession(BOB, 'bob game');

    const alices = await ctx.service.list(ALICE);
    const bobs = await ctx.service.list(BOB);
    expect(alices).toHaveLength(1);
    expect(bobs).toHaveLength(1);
    expect(alices[0]!.title).toContain('alice game');
    expect(bobs[0]!.title).toContain('bob game');
  });
});

describe('DesignService — manual edits and revert', () => {
  let ctx: Awaited<ReturnType<typeof build>>;
  beforeEach(async () => {
    ctx = await build();
  });

  it('accepts a hand-edited draft and validates it the same way', async () => {
    const created = await ctx.service.createSession(ALICE, 'a game');
    const edited = await ctx.service.applyManualEdit(
      created.sessionId,
      ALICE,
      { ...callbreak, displayName: 'Hand Edited' },
      strategy,
    );

    const latest = edited.revisions[edited.revisions.length - 1]!;
    expect((latest.draft.rules as RulesDsl).displayName).toBe('Hand Edited');
    expect(latest.diagnostics.valid).toBe(true);
    expect(latest.prompt).toBe('');
    // No model call — a hand edit is not a drafting request.
    expect(ctx.provider.calls).toBe(1);
  });

  it('records a hand edit that breaks the draft, rather than refusing it', async () => {
    const created = await ctx.service.createSession(ALICE, 'a game');
    const edited = await ctx.service.applyManualEdit(created.sessionId, ALICE, { displayName: 'Broken' }, strategy);

    const latest = edited.revisions[edited.revisions.length - 1]!;
    expect(latest.diagnostics.valid).toBe(false);
    // The author asked to save this; refusing would lose their work. Publishing
    // is where it gets stopped.
    await expect(ctx.service.publish(created.sessionId, ALICE)).rejects.toThrow(DesignNotPublishableError);
  });

  it('reverts by appending, never by truncating history', async () => {
    const created = await ctx.service.createSession(ALICE, 'original');
    await ctx.service.applyManualEdit(created.sessionId, ALICE, { ...callbreak, displayName: 'Changed' }, strategy);

    const reverted = await ctx.service.revert(created.sessionId, ALICE, 1);

    expect(reverted.revisions.map((r) => r.n)).toEqual([1, 2, 3]);
    const latest = reverted.revisions[2]!;
    expect(latest.summary).toBe('Reverted to revision 1.');
    expect((latest.draft.rules as RulesDsl).displayName).toBe(
      (reverted.revisions[0]!.draft.rules as RulesDsl).displayName,
    );
    // Revision 2 is still there — reverting twice, in either direction, works.
    expect((reverted.revisions[1]!.draft.rules as RulesDsl).displayName).toBe('Changed');
  });

  it('rejects a revert to a revision that does not exist', async () => {
    const created = await ctx.service.createSession(ALICE, 'original');
    await expect(ctx.service.revert(created.sessionId, ALICE, 99)).rejects.toThrow(DesignNotFoundError);
  });
});

describe('DesignService — publishing', () => {
  let ctx: Awaited<ReturnType<typeof build>>;
  beforeEach(async () => {
    ctx = await build();
  });

  it('imports the draft through PluginManager and records the game id', async () => {
    const created = await ctx.service.createSession(ALICE, 'my game');
    const { session, gameId } = await ctx.service.publish(created.sessionId, ALICE);

    expect(session.publishedGameId).toBe(gameId);

    // It is a real, owned entry in the catalog — same as an uploaded plugin.
    const published = await ctx.plugins.getVisible(gameId, ALICE);
    expect(published.imported).toBe(true);
    expect(published.ownerUserId).toBe(ALICE);
    expect((await ctx.plugins.summaries(ALICE)).some((g) => g.gameId === gameId)).toBe(true);
    // ...and private to its author.
    await expect(ctx.plugins.getVisible(gameId, BOB)).rejects.toThrow(/Unknown gameId/);
  });

  it('updates the same game on a second publish instead of making another', async () => {
    const created = await ctx.service.createSession(ALICE, 'my game');
    const first = await ctx.service.publish(created.sessionId, ALICE);

    await ctx.service.applyManualEdit(created.sessionId, ALICE, { ...callbreak, displayName: 'Renamed' }, strategy);
    const second = await ctx.service.publish(created.sessionId, ALICE);

    expect(second.gameId).toBe(first.gameId);
    const owned = (await ctx.plugins.summaries(ALICE)).filter((g) => g.imported);
    expect(owned).toHaveLength(1);
    expect(owned[0]!.displayName).toBe('Renamed');
  });

  it('re-imports when the previously published game has been deleted', async () => {
    const created = await ctx.service.createSession(ALICE, 'my game');
    const first = await ctx.service.publish(created.sessionId, ALICE);
    await ctx.plugins.deletePlugin(first.gameId, ALICE);

    const second = await ctx.service.publish(created.sessionId, ALICE);

    expect(second.gameId).not.toBe(first.gameId);
    expect((await ctx.plugins.summaries(ALICE)).some((g) => g.gameId === second.gameId)).toBe(true);
  });

  it('refuses to publish a draft that still has errors, naming them', async () => {
    const created = await ctx.service.createSession(ALICE, 'my game');
    await ctx.service.applyManualEdit(created.sessionId, ALICE, { displayName: 'Nonsense' }, strategy);

    await expect(ctx.service.publish(created.sessionId, ALICE)).rejects.toThrow(DesignNotPublishableError);
    // Nothing reached the catalog.
    expect((await ctx.plugins.summaries(ALICE)).filter((g) => g.imported)).toHaveLength(0);
  });

  it('leaves a published game alone when the session is deleted', async () => {
    const created = await ctx.service.createSession(ALICE, 'my game');
    const { gameId } = await ctx.service.publish(created.sessionId, ALICE);

    await ctx.service.delete(created.sessionId, ALICE);

    expect(await ctx.service.list(ALICE)).toEqual([]);
    // Deleting your design notes must not delete the game you made from them.
    await expect(ctx.plugins.getVisible(gameId, ALICE)).resolves.toBeTruthy();
  });
});
