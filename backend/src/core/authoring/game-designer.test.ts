/**
 * The designer's contract with an unreliable model.
 *
 * Every test here drives a scripted provider rather than a real API: the
 * behaviour worth pinning down is what happens when the model returns
 * something *wrong*, and a live model cannot be asked to be wrong on cue. The
 * scripted responses are the actual failure shapes seen in practice — a fenced
 * reply, a preamble, a truncated object, a draft that validates but deadlocks.
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RulesDsl } from '@hcg/shared';
import type { LLMCompletionProvider, LLMCompletionRequest } from '../ai/provider.js';
import { briefConcernsStrategy, DesignError, GameDesigner, parseDesignResponse } from './game-designer.js';

const gamesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'games');
const callbreak = JSON.parse(readFileSync(path.join(gamesRoot, 'callbreak', 'rules.json'), 'utf-8')) as RulesDsl;
const strategy = readFileSync(path.join(gamesRoot, 'callbreak', 'strategy.md'), 'utf-8');

/** Answers with a scripted list of responses, one per call, in order. */
class ScriptedProvider implements LLMCompletionProvider {
  readonly name = 'scripted';
  readonly model = 'test-model';
  readonly prompts: string[] = [];
  private index = 0;

  constructor(private readonly responses: readonly string[]) {}

  async complete(request: LLMCompletionRequest): Promise<string> {
    this.prompts.push(request.userPrompt);
    const response = this.responses[this.index];
    if (response === undefined) throw new Error(`ScriptedProvider ran out of responses after ${this.index} calls`);
    this.index++;
    return response;
  }

  get callCount(): number {
    return this.index;
  }
}

function envelope(rules: unknown, opts: { summary?: string; notes?: string[]; strategy?: string } = {}): string {
  return JSON.stringify({
    summary: opts.summary ?? 'Drafted the game.',
    notes: opts.notes ?? [],
    rules,
    strategy: opts.strategy ?? strategy,
  });
}

/** Callbreak with one field changed — the base for "valid" responses. */
function variant(change: (d: Record<string, unknown>) => void): unknown {
  const copy = JSON.parse(JSON.stringify(callbreak)) as Record<string, unknown>;
  change(copy);
  return copy;
}

describe('GameDesigner — happy path', () => {
  it('returns a validated draft on the first attempt', async () => {
    const provider = new ScriptedProvider([envelope(callbreak, { summary: 'Made Callbreak.', notes: ['n'] })]);
    const designer = new GameDesigner(provider);

    const result = await designer.design({ brief: 'a four player spades game' });

    expect(result.diagnostics.valid).toBe(true);
    expect(result.repairAttempts).toBe(0);
    expect(result.summary).toBe('Made Callbreak.');
    expect(result.notes).toEqual(['n']);
    expect(provider.callCount).toBe(1);
  });

  it('puts the brief in the prompt, and no prior draft on the first turn', async () => {
    const provider = new ScriptedProvider([envelope(callbreak)]);
    await new GameDesigner(provider).design({ brief: 'a trick game for three' });

    expect(provider.prompts[0]).toContain('a trick game for three');
    expect(provider.prompts[0]).not.toContain('Current rules.json');
  });

  it('sends the prior draft and earlier briefs when refining', async () => {
    const provider = new ScriptedProvider([envelope(callbreak)]);
    await new GameDesigner(provider).design({
      brief: 'make it three players',
      prior: { rules: callbreak, strategy },
      history: ['a spades game', 'add bidding'],
    });

    const prompt = provider.prompts[0]!;
    expect(prompt).toContain('Current rules.json');
    expect(prompt).toContain('Callbreak');
    expect(prompt).toContain('a spades game');
    expect(prompt).toContain('make it three players');
  });

  it('reports the provider and model for the UI footer', () => {
    expect(new GameDesigner(new ScriptedProvider([])).modelLabel).toBe('scripted/test-model');
  });
});

describe('GameDesigner — the repair loop', () => {
  it('feeds validation errors back and accepts the corrected draft', async () => {
    const broken = variant((d) => {
      (d.players as Record<string, unknown>).defaultCount = 99;
    });
    const provider = new ScriptedProvider([envelope(broken), envelope(callbreak)]);

    const result = await new GameDesigner(provider).design({ brief: 'callbreak' });

    expect(provider.callCount).toBe(2);
    expect(result.repairAttempts).toBe(1);
    expect(result.diagnostics.valid).toBe(true);
    // The repair prompt has to carry the specific failure, not just "invalid".
    expect(provider.prompts[1]).toContain('defaultCount');
    // ...and the failing draft itself, so the model is not patching blind.
    expect(provider.prompts[1]).toContain('Here is the draft that failed');
    expect(provider.prompts[1]).toContain('"defaultCount": 99');
  });

  it('repairs a draft that validates but cannot be played', async () => {
    const deadlocking = variant((d) => {
      d.phases = [
        { name: 'DEALING', kind: 'DEALING', next: 'EXCHANGE' },
        { name: 'EXCHANGE', kind: 'CARD_EXCHANGE', next: 'PLAYING' },
        { name: 'PLAYING', kind: 'PLAYING', next: 'SCORING' },
        { name: 'SCORING', kind: 'SCORING', next: null },
      ];
    });
    const provider = new ScriptedProvider([envelope(deadlocking), envelope(callbreak)]);

    const result = await new GameDesigner(provider).design({ brief: 'callbreak with a discard' });

    expect(result.diagnostics.valid).toBe(true);
    expect(provider.prompts[1]).toContain('could not deal and play');
    expect(provider.prompts[1]).toContain('EXCHANGE');
  });

  it('gives up after the attempt budget and returns the draft anyway', async () => {
    const broken = variant((d) => {
      (d.players as Record<string, unknown>).defaultCount = 99;
    });
    // 1 initial + 2 repairs = 3 calls, all failing.
    const provider = new ScriptedProvider([envelope(broken), envelope(broken), envelope(broken)]);

    const result = await new GameDesigner(provider, { maxRepairAttempts: 2 }).design({ brief: 'x' });

    expect(provider.callCount).toBe(3);
    expect(result.repairAttempts).toBe(2);
    expect(result.diagnostics.valid).toBe(false);
    // The point of returning it: the author gets something to look at and fix,
    // not an error and an empty editor.
    expect(result.draft.rules).toBeTruthy();
    expect(result.diagnostics.diagnostics.length).toBeGreaterThan(0);
  });

  it('honours a repair budget of zero', async () => {
    const broken = variant((d) => {
      (d.players as Record<string, unknown>).defaultCount = 99;
    });
    const provider = new ScriptedProvider([envelope(broken)]);
    const result = await new GameDesigner(provider, { maxRepairAttempts: 0 }).design({ brief: 'x' });

    expect(provider.callCount).toBe(1);
    expect(result.diagnostics.valid).toBe(false);
  });
});

describe('GameDesigner — carrying the strategy guide forward', () => {
  /**
   * The reply ceiling is charged against the same per-minute token budget as
   * the prompt, so re-sending and re-receiving an unchanged 1400-token guide on
   * every rules tweak is the single largest avoidable cost in the loop — and
   * every regeneration is a chance to degrade a guide the author liked.
   */
  it('omits the guide from a rules-only refine, and keeps the existing one', async () => {
    const rulesOnly = JSON.stringify({ summary: 'Made it 3 players.', notes: [], rules: callbreak });
    const provider = new ScriptedProvider([rulesOnly]);

    const result = await new GameDesigner(provider).design({
      brief: 'make the deck 32 cards',
      prior: { rules: callbreak, strategy },
    });

    expect(provider.prompts[0]).not.toContain('Current strategy.md');
    expect(provider.prompts[0]).toContain('unchanged and is not shown');
    // The guide survives untouched even though the model never sent one back.
    expect(result.draft.strategy).toBe(strategy);
    expect(result.diagnostics.valid).toBe(true);
  });

  it('asks for the guide when the instruction is about it', async () => {
    const provider = new ScriptedProvider([envelope(callbreak, { strategy: 'a new guide' })]);
    await new GameDesigner(provider).design({
      brief: 'the bots play badly — improve the strategy guide',
      prior: { rules: callbreak, strategy },
    });

    expect(provider.prompts[0]).toContain('Current strategy.md');
  });

  it('always asks for a guide on a first draft, which has none to inherit', async () => {
    const provider = new ScriptedProvider([envelope(callbreak)]);
    await new GameDesigner(provider).design({ brief: 'a new trick game' });
    // No prior draft means nothing to carry forward, so the guide is mandatory.
    expect(provider.prompts[0]).not.toContain('unchanged and is not shown');
  });

  it('takes a guide the model volunteered even when one was not asked for', async () => {
    const provider = new ScriptedProvider([envelope(callbreak, { strategy: 'volunteered guide text' })]);
    const result = await new GameDesigner(provider).design({
      brief: 'change the deck',
      prior: { rules: callbreak, strategy },
    });
    expect(result.draft.strategy).toBe('volunteered guide text');
  });

  it('classifies which briefs are about the guide', () => {
    for (const brief of ['improve the strategy', 'the bots are weak', 'better AI play', 'rewrite the guide']) {
      expect(briefConcernsStrategy(brief), brief).toBe(true);
    }
    for (const brief of ['make it 3 players', 'add a nil bid', 'use a 32 card deck']) {
      expect(briefConcernsStrategy(brief), brief).toBe(false);
    }
  });
});

describe('GameDesigner — hostile responses', () => {
  it('times out with an explanation rather than a raw abort error', async () => {
    const hanging: LLMCompletionProvider = {
      name: 'hanging',
      model: 'm',
      complete: (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason));
        }),
    };

    await expect(new GameDesigner(hanging, { timeoutMs: 20 }).design({ brief: 'x' })).rejects.toThrow(DesignError);
  });

  it('wraps a provider failure as a DesignError', async () => {
    const failing: LLMCompletionProvider = {
      name: 'failing',
      model: 'm',
      complete: () => Promise.reject(new Error('groq provider failed: 401')),
    };

    await expect(new GameDesigner(failing).design({ brief: 'x' })).rejects.toThrow(/401/);
  });

  it('asks for JSON and a large token budget', async () => {
    const complete = vi.fn().mockResolvedValue(envelope(callbreak));
    await new GameDesigner({ name: 'spy', model: 'm', complete }).design({ brief: 'x' });

    const request = complete.mock.calls[0]![0] as LLMCompletionRequest;
    expect(request.json).toBe(true);
    expect(request.maxTokens).toBeGreaterThan(4000);
  });
});

describe('parseDesignResponse', () => {
  it('reads a bare JSON object', () => {
    const parsed = parseDesignResponse(envelope(callbreak, { summary: 's', notes: ['a', 'b'] }));
    expect(parsed.summary).toBe('s');
    expect(parsed.notes).toEqual(['a', 'b']);
    expect((parsed.draft.rules as RulesDsl).displayName).toBe('Callbreak');
  });

  it('survives a markdown fence and a chatty preamble', () => {
    const raw = `Sure! Here's your game:\n\n\`\`\`json\n${envelope(callbreak)}\n\`\`\`\n\nLet me know if you'd like changes.`;
    expect((parseDesignResponse(raw).draft.rules as RulesDsl).displayName).toBe('Callbreak');
  });

  it('is not fooled by braces inside the strategy string', () => {
    // The naive "first { to last }" scan gets this wrong when the strategy text
    // itself contains a closing brace.
    const raw = envelope(callbreak, { strategy: 'Lead low. Consider {A,K,Q} as a block. Then attack.' });
    const parsed = parseDesignResponse(raw);
    expect(parsed.draft.strategy).toContain('{A,K,Q}');
    expect((parsed.draft.rules as RulesDsl).displayName).toBe('Callbreak');
  });

  it('strips a gameId the model emitted despite being told not to', () => {
    const raw = JSON.stringify({ summary: 's', notes: [], rules: { ...callbreak, gameId: 'sneaky' }, strategy });
    const rules = parseDesignResponse(raw).draft.rules as Record<string, unknown>;
    expect(rules.gameId).toBeUndefined();
    expect(rules.displayName).toBe('Callbreak');
  });

  it('explains a truncated response as a token-limit problem', () => {
    const cut = envelope(callbreak).slice(0, 200);
    expect(() => parseDesignResponse(cut)).toThrow(/cut off/i);
  });

  it('rejects a response with no rules object', () => {
    expect(() => parseDesignResponse(JSON.stringify({ summary: 'here you go', notes: [] }))).toThrow(DesignError);
  });

  it('tolerates missing summary and notes', () => {
    const parsed = parseDesignResponse(JSON.stringify({ rules: callbreak, strategy }));
    expect(parsed.summary).toBeTruthy();
    expect(parsed.notes).toEqual([]);
  });

  it('drops non-string notes rather than rendering them', () => {
    const parsed = parseDesignResponse(
      JSON.stringify({ rules: callbreak, strategy, notes: ['keep', 42, null, '  ', 'also'] }),
    );
    expect(parsed.notes).toEqual(['keep', 'also']);
  });
});
