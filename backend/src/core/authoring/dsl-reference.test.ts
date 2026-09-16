/**
 * Drift guard between `shared/src/rules-schema.ts` and the reference the game
 * designer authors against.
 *
 * The failure this exists to catch is silent and expensive: someone adds a
 * trump mode or a scoring formula to the DSL, every existing test passes, and
 * the designer simply never produces a game using it — because it was never
 * told the primitive exists. Nothing about that looks like a bug from the
 * outside; it looks like a model that isn't very good.
 *
 * So the schema source is read as text and its union members extracted, rather
 * than hardcoding a list here that would drift in exactly the same way.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DSL_EXAMPLE, DSL_LIMITATIONS, DSL_REFERENCE, STRATEGY_GUIDE_BRIEF } from './dsl-reference.js';
import { validateRulesDsl } from '@hcg/shared';

const schemaSource = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'shared', 'src', 'rules-schema.ts'),
  'utf-8',
);

/**
 * Pulls the string literals out of a named type alias's union, e.g.
 * `export type TrumpMode = | 'static' | 'bid-selected' ...`.
 */
function unionMembers(typeName: string): string[] {
  const match = schemaSource.match(new RegExp(`export type ${typeName} =([\\s\\S]*?);`));
  expect(match, `could not find "export type ${typeName}" in rules-schema.ts`).toBeTruthy();
  return [...match![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

describe('DSL reference stays in sync with the schema', () => {
  it('names every TrumpMode', () => {
    const modes = unionMembers('TrumpMode');
    expect(modes.length).toBeGreaterThan(3);
    for (const mode of modes) expect(DSL_REFERENCE, `TrumpMode "${mode}"`).toContain(mode);
  });

  it('names every PhaseKind', () => {
    for (const kind of unionMembers('PhaseKind')) {
      expect(DSL_REFERENCE, `PhaseKind "${kind}"`).toContain(kind);
    }
  });

  it('names every ActionTypeName', () => {
    for (const action of unionMembers('ActionTypeName')) {
      expect(DSL_REFERENCE, `ActionTypeName "${action}"`).toContain(action);
    }
  });

  it('names every CompoundCondition kind', () => {
    const match = schemaSource.match(/export type CompoundCondition =([\s\S]*?);/);
    const kinds = [...match![1]!.matchAll(/kind:\s*'([^']+)'/g)].map((m) => m[1]!);
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) expect(DSL_REFERENCE, `condition "${kind}"`).toContain(kind);
  });

  it('names every ScoringFormula kind', () => {
    // The formula union is heavily commented, so the `kind` fields are pulled
    // out of the object members rather than from a flat literal list.
    const match = schemaSource.match(/export type ScoringFormula =([\s\S]*?)\n\/\*\*/);
    const kinds = [...match![1]!.matchAll(/readonly kind:\s*'([^']+)'/g)].map((m) => m[1]!);
    expect(kinds.length).toBe(8);
    for (const kind of kinds) expect(DSL_REFERENCE, `formula "${kind}"`).toContain(kind);
  });

  it('names every deal mode', () => {
    for (const mode of ['fixed', 'even-split', 'schedule']) {
      expect(DSL_REFERENCE, `deal mode "${mode}"`).toContain(mode);
    }
  });
});

describe('DSL reference content', () => {
  it('tells the model not to author a gameId', () => {
    // The one instruction whose absence produces a draft the server rejects
    // outright, so it is worth asserting rather than trusting.
    expect(DSL_REFERENCE).toContain('gameId');
    expect(DSL_REFERENCE.toLowerCase()).toContain('never include a "gameId"'.toLowerCase());
  });

  it('warns off the primitives the engine cannot execute yet', () => {
    // These two are declarable in the schema but generate no moves, so a draft
    // using them deadlocks. See TODO.md.
    expect(DSL_LIMITATIONS).toContain('CARD_EXCHANGE');
    expect(DSL_LIMITATIONS).toContain('microPhases');
  });

  it('explains what strategy.md is actually for', () => {
    expect(STRATEGY_GUIDE_BRIEF).toContain('system prompt');
  });

  it('ships a worked example that is itself a valid rules.json', () => {
    // A malformed example is worse than none: it is the single most closely
    // copied part of the prompt.
    const json = DSL_EXAMPLE.slice(DSL_EXAMPLE.indexOf('{'));
    const result = validateRulesDsl(JSON.parse(json));
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });
});
