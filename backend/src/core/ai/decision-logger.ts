/**
 * Terminal logging for AI decisions.
 *
 * The `Decision` returned by `decideTurn` already carries the model's chosen
 * move, its free-text reasoning, and how the choice was reached (llm /
 * fallback / forced). None of that was visible anywhere — this renders it to
 * the terminal so the AI's play can actually be followed and debugged.
 *
 * Injected into `MatchManager` rather than called directly from it, so tests
 * can run silently by simply not passing a logger.
 */

import type { Decision, LegalMove, SeatIndex } from '@hcg/shared';

export interface DecisionLogEntry {
  readonly matchId: string;
  readonly gameId: string;
  readonly seat: SeatIndex;
  readonly playerName: string;
  readonly phase: string;
  readonly decision: Decision;
  /** The move the decision resolved to, for its human-readable label. */
  readonly move: LegalMove | undefined;
  readonly legalMoveCount: number;
}

export type DecisionLogger = (entry: DecisionLogEntry) => void;

// Colour is opt-out via the NO_COLOR convention, and skipped when stdout is
// not a TTY so piped logs don't fill up with escape codes.
const useColor = process.env.NO_COLOR === undefined && process.stdout.isTTY === true;
const ESC = '\u001b';
const c = (code: string, text: string): string => (useColor ? `${ESC}[${code}m${text}${ESC}[0m` : text);


const dim = (t: string): string => c('2', t);
const bold = (t: string): string => c('1', t);
const cyan = (t: string): string => c('36', t);
const green = (t: string): string => c('32', t);
const yellow = (t: string): string => c('33', t);
const red = (t: string): string => c('31', t);
const magenta = (t: string): string => c('35', t);

function sourceBadge(source: Decision['source']): string {
  switch (source) {
    case 'llm':
      return green('LLM     ');
    case 'fallback':
      return red('FALLBACK');
    case 'forced':
      return dim('FORCED  ');
    case 'human':
      return cyan('HUMAN   ');
  }
}

function latencyLabel(ms: number | undefined): string {
  if (ms === undefined) return '';
  // PRD 6 budgets the LLM call at 1200ms — flag anything approaching it.
  const text = `${ms}ms`;
  if (ms >= 1200) return red(text);
  if (ms >= 800) return yellow(text);
  return dim(text);
}

/** Prints a header so a match's decision stream is visually separable in the terminal. */
export function logMatchStart(gameId: string, startedBy: string, humanSeats: readonly number[]): void {
  const seats = humanSeats.length > 0 ? humanSeats.join(', ') : 'none (all AI)';
  console.log('');
  console.log(`${bold('▸ ' + gameId)} ${dim(`· started by ${startedBy} · human seat(s): ${seats}`)}`);
}

export interface ConsoleDecisionLoggerOptions {
  /** Also print the full reasoning text rather than truncating it to one line. */
  readonly verbose?: boolean;
}

export function createConsoleDecisionLogger(opts: ConsoleDecisionLoggerOptions = {}): DecisionLogger {
  return (entry) => {
    const { decision, move, seat, playerName, phase, legalMoveCount } = entry;

    const header = [
      dim('│'),
      sourceBadge(decision.source),
      bold(`seat ${seat}`),
      dim(`(${playerName})`),
      dim('·'),
      magenta(phase),
      dim(`· ${legalMoveCount} option${legalMoveCount === 1 ? '' : 's'}`),
      latencyLabel(decision.latencyMs),
    ]
      .filter(Boolean)
      .join(' ');

    console.log(header);
    console.log(`${dim('│')} ${cyan('→')} ${move?.label ?? decision.moveId}`);

    if (decision.reasoning) {
      const reasoning = decision.reasoning.trim().replace(/\s+/g, ' ');
      const isFailureNote = decision.source === 'fallback';
      const body =
        opts.verbose || reasoning.length <= 160 ? reasoning : `${reasoning.slice(0, 157)}…`;
      console.log(`${dim('│')} ${isFailureNote ? red('!') : dim('"')} ${isFailureNote ? red(body) : dim(body)}`);
    }
  };
}
