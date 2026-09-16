/**
 * The validator is the designer's only real guarantee, so these tests are
 * mostly about the cases `validateRulesDsl` alone lets through — a document
 * that satisfies every field constraint and still cannot be played.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RulesDsl } from '@hcg/shared';
import { validateRulesDsl } from '@hcg/shared';
import { validateDraft } from './draft-validator.js';

const gamesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'games');

function builtIn(id: string): { rules: RulesDsl; strategy: string } {
  return {
    rules: JSON.parse(readFileSync(path.join(gamesRoot, id, 'rules.json'), 'utf-8')) as RulesDsl,
    strategy: readFileSync(path.join(gamesRoot, id, 'strategy.md'), 'utf-8'),
  };
}

/** Deep-clones so a test can mutate one field without disturbing the others. */
function mutate(rules: RulesDsl, change: (draft: Record<string, unknown>) => void): unknown {
  const copy = JSON.parse(JSON.stringify(rules)) as Record<string, unknown>;
  change(copy);
  return copy;
}

const errorsOf = (d: ReturnType<typeof validateDraft>): string[] =>
  d.diagnostics.filter((x) => x.severity === 'error').map((x) => x.message);

const warningsOf = (d: ReturnType<typeof validateDraft>): string[] =>
  d.diagnostics.filter((x) => x.severity === 'warning').map((x) => x.message);

describe('validateDraft — shipped games', () => {
  // If the validator cannot accept the games this engine ships with, it is
  // measuring something other than playability.
  for (const id of ['29', 'callbreak']) {
    it(`accepts the built-in "${id}"`, () => {
      const { rules, strategy } = builtIn(id);
      const result = validateDraft(rules, strategy);
      expect(errorsOf(result)).toEqual([]);
      expect(result.valid).toBe(true);
      expect(result.playable).toBe(true);
    });
  }
});

describe('validateDraft — structural failures', () => {
  it('rejects a non-object', () => {
    const result = validateDraft('not a rules document', 'guide');
    expect(result.valid).toBe(false);
    expect(result.playable).toBe(false);
  });

  it('reports the schema errors verbatim, so the repair prompt is specific', () => {
    const broken = mutate(builtIn('callbreak').rules, (d) => {
      (d.players as Record<string, unknown>).defaultCount = 9;
    });
    const result = validateDraft(broken, 'guide');
    expect(result.valid).toBe(false);
    expect(errorsOf(result)).toEqual(validateRulesDsl(broken).errors);
  });

  it('rejects a gameId, matching what the plugin layer would do on publish', () => {
    const withId = mutate(builtIn('callbreak').rules, (d) => {
      d.gameId = 'my-game';
    });
    expect(errorsOf(validateDraft(withId, 'guide')).join(' ')).toContain('gameId');
  });

  it('treats an empty strategy.md as an error, since publishing would refuse it', () => {
    const { rules } = builtIn('callbreak');
    const result = validateDraft(rules, '   ');
    expect(result.valid).toBe(false);
    expect(errorsOf(result).join(' ')).toContain('strategy.md is empty');
  });
});

describe('validateDraft — playability', () => {
  /**
   * The headline case. `CARD_EXCHANGE` is a declarable `PhaseKind` that
   * `generateLegalMoves` has no implementation for, so a draft using it passes
   * every structural check and then deadlocks the moment a real hand reaches
   * that phase. Only actually dealing and playing the game finds it.
   */
  it('catches a structurally valid game that deadlocks in play', () => {
    const { rules, strategy } = builtIn('callbreak');
    const deadlocking = mutate(rules, (d) => {
      d.phases = [
        { name: 'DEALING', kind: 'DEALING', next: 'EXCHANGE' },
        { name: 'EXCHANGE', kind: 'CARD_EXCHANGE', next: 'BIDDING' },
        { name: 'BIDDING', kind: 'BIDDING', next: 'PLAYING' },
        { name: 'PLAYING', kind: 'PLAYING', next: 'SCORING' },
        { name: 'SCORING', kind: 'SCORING', next: null },
      ];
    });

    // Precondition: the schema itself is happy with this document.
    expect(validateRulesDsl(deadlocking).valid).toBe(true);

    const result = validateDraft(deadlocking, strategy);
    expect(result.playable).toBe(false);
    expect(result.valid).toBe(false);
    // The message has to name the phase, or the repair prompt is useless.
    expect(errorsOf(result).join(' ')).toContain('EXCHANGE');
  });

  it('is deterministic — the same draft always gets the same verdict', () => {
    const { rules, strategy } = builtIn('29');
    const first = validateDraft(rules, strategy);
    const second = validateDraft(rules, strategy);
    expect(second).toEqual(first);
  });

  it('plays every table size a variable-size game claims to support', () => {
    // Callbreak ships fixed at 4; widening it to 3-6 must still deal and play
    // at each size, which is what `supportedPlayerCounts` drives.
    const { rules, strategy } = builtIn('callbreak');
    const widened = mutate(rules, (d) => {
      d.players = { min: 3, max: 6, defaultCount: 4, topology: 'solo' };
      (d.bidding as Record<string, unknown>).maxBid = 8;
    });
    const result = validateDraft(widened, strategy);
    expect(errorsOf(result)).toEqual([]);
    expect(result.playable).toBe(true);
  });
});

describe('validateDraft — advisory warnings', () => {
  it('warns when a match is only one hand long', () => {
    const { rules, strategy } = builtIn('callbreak');
    const singleHand = mutate(rules, (d) => {
      delete (d.scoring as Record<string, unknown>).maxHands;
    });
    const result = validateDraft(singleHand, strategy);
    // Advisory only: the draft is still publishable.
    expect(result.valid).toBe(true);
    expect(warningsOf(result).join(' ')).toContain('single hand');
  });

  it('warns when contractBasis is "points" but nothing scores points', () => {
    const { rules, strategy } = builtIn('callbreak');
    const pointless = mutate(rules, (d) => {
      (d.scoring as Record<string, unknown>).contractBasis = 'points';
      // A contract-free formula, so the hand still plays and scores — the
      // point being that it scores *zero*, every hand, forever.
      (d.scoring as Record<string, unknown>).formula = { kind: 'capture' };
    });
    const result = validateDraft(pointless, strategy);
    expect(warningsOf(result).join(' ')).toContain('no card carries any point value');
  });

  it('warns when penalty scoring is not paired with lowerIsBetter', () => {
    const { rules, strategy } = builtIn('callbreak');
    const inverted = mutate(rules, (d) => {
      (d.scoring as Record<string, unknown>).contractBasis = 'none';
      (d.scoring as Record<string, unknown>).formula = { kind: 'penalty-points' };
      delete (d as Record<string, unknown>).bidding;
      d.phases = [
        { name: 'DEALING', kind: 'DEALING', next: 'PLAYING' },
        { name: 'PLAYING', kind: 'PLAYING', next: 'SCORING' },
        { name: 'SCORING', kind: 'SCORING', next: null },
      ];
      (d.deck as Record<string, unknown>).pointValues = { A: 1 };
    });
    const result = validateDraft(inverted, strategy);
    expect(warningsOf(result).join(' ')).toContain('lowerIsBetter');
  });

  it('warns about a thin strategy guide without blocking it', () => {
    const { rules } = builtIn('callbreak');
    const result = validateDraft(rules, 'Play well.');
    expect(result.valid).toBe(true);
    expect(warningsOf(result).join(' ')).toContain('strategy.md is only');
  });
});
