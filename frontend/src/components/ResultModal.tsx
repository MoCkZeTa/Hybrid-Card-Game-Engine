import { useEffect, useRef, useState } from 'react';
import type { ResultRow, ResultSummary } from '@hcg/shared';

/**
 * The round / game-over popup.
 *
 * Everything shown here comes from the generic `ResultSummary` the engine
 * builds from the rules DSL — competitor labels, what the "made" column
 * counts, whether a contract even applies. Nothing is specific to 29 or
 * Callbreak, so a newly imported plugin gets a correct result screen for free.
 */
export function ResultModal({
  result,
  viewerSeat,
  viewerWon,
  nextRoundInMs,
  onDismiss,
  onLeave,
}: {
  result: ResultSummary;
  /** Used only to mark which row is the reader's own. */
  viewerSeat: number;
  viewerWon: boolean | null;
  /** Milliseconds until the next hand deals, counted from when this state arrived. Null for a finished match. */
  nextRoundInMs: number | null;
  onDismiss: () => void;
  onLeave: () => void;
}): JSX.Element {
  const isGameOver = result.scope === 'GAME';
  const remaining = useCountdown(nextRoundInMs);

  // The round popup steps aside on its own when the next hand is dealt; the
  // game-over one stays until it's acted on.
  useEffect(() => {
    if (isGameOver || remaining === null || remaining > 0) return;
    onDismiss();
  }, [isGameOver, remaining, onDismiss]);

  const winners = isGameOver ? result.winnerKeys : result.roundWinnerKeys;
  const winnerNames = result.rows.filter((r) => winners.includes(r.key)).map((r) => r.label);
  const tied = winnerNames.length > 1;

  return (
    <div className="result-backdrop" role="dialog" aria-modal="true" aria-labelledby="result-title">
      <div className={`result-card ${isGameOver ? 'result-card-final' : ''}`}>
        <header className="result-head">
          <span className="kicker">
            {isGameOver
              ? result.endReason === 'target-score'
                ? 'Target score reached'
                : 'Final hand'
              : result.totalHands === null
                ? `Round ${result.handNumber}`
                : `Round ${result.handNumber} of ${result.totalHands}`}
          </span>
          <h2 className="result-title" id="result-title">
            {isGameOver ? 'Game Over' : 'Round Complete'}
          </h2>
          <p className={`result-verdict ${verdictTone(viewerWon)}`}>
            {viewerWon === null
              ? `${joinNames(winnerNames)} ${tied ? 'tie' : 'leads'}`
              : viewerWon
                ? isGameOver
                  ? tied ? 'You share the win' : 'You win'
                  : tied ? 'You share the round' : 'You take the round'
                : `${joinNames(winnerNames)} ${tied ? 'tie it' : isGameOver ? 'wins' : 'takes it'}`}
          </p>
        </header>

        <table className="result-table">
          <thead>
            <tr>
              <th className="result-col-rank" scope="col">
                #
              </th>
              <th scope="col">{result.rows[0]?.seats.length === 1 ? 'Player' : 'Team'}</th>
              {result.basis !== 'none' && (
                <th className="result-col-num" scope="col">
                  Bid
                </th>
              )}
              <th className="result-col-num" scope="col">
                {result.basis === 'points' ? 'Points' : 'Tricks'}
              </th>
              <th className="result-col-num" scope="col">
                This round
              </th>
              <th className="result-col-num" scope="col">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row) => (
              <ResultTableRow
                key={row.key}
                row={row}
                basis={result.basis}
                isWinner={winners.includes(row.key)}
                isViewer={row.seats.includes(viewerSeat)}
              />
            ))}
          </tbody>
        </table>

        <footer className="result-actions">
          {isGameOver ? (
            <>
              <button className="btn btn-ghost" onClick={onDismiss}>
                Review table
              </button>
              <button className="btn btn-primary" onClick={onLeave}>
                Back to lobby
              </button>
            </>
          ) : (
            <>
              <button className="btn btn-ghost" onClick={onDismiss}>
                Skip
              </button>
              <button className="btn btn-primary result-next" disabled>
                {remaining === null ? 'Dealing next round…' : `Next round in ${Math.ceil(remaining / 1000)}s`}
                {remaining !== null && nextRoundInMs !== null && nextRoundInMs > 0 && (
                  <span
                    className="result-next-fill"
                    style={{ transform: `scaleX(${1 - remaining / nextRoundInMs})` }}
                  />
                )}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

function ResultTableRow({
  row,
  basis,
  isWinner,
  isViewer,
}: {
  row: ResultRow;
  basis: ResultSummary['basis'];
  isWinner: boolean;
  isViewer: boolean;
}): JSX.Element {
  return (
    <tr
      className={['result-row', isWinner ? 'result-row-win' : '', isViewer ? 'result-row-you' : '']
        .filter(Boolean)
        .join(' ')}
    >
      <td className="result-col-rank">
        <span className={`result-rank result-rank-${row.rank}`}>{row.rank}</span>
      </td>
      <td>
        <span className="result-name">
          {row.label}
          {isViewer && <span className="result-you">you</span>}
        </span>
        {/* A team's roster is worth showing; a solo row's "roster" is just its own name. */}
        {row.seats.length > 1 && <span className="result-roster">{row.playerNames.join(' & ')}</span>}
        <span className="result-badges">
          {row.isDeclarer && <span className="result-badge result-badge-declarer">Declarer</span>}
          {row.contract && (
            <span className={`result-badge result-badge-${row.contract.toLowerCase()}`}>
              {row.contract === 'MADE' ? 'Made it' : 'Missed'}
            </span>
          )}
        </span>
      </td>
      {basis !== 'none' && <td className="result-col-num">{row.bid ?? '—'}</td>}
      <td className="result-col-num">{row.made}</td>
      <td className={`result-col-num result-delta ${row.delta >= 0 ? 'result-delta-up' : 'result-delta-down'}`}>
        {row.delta > 0 ? '+' : ''}
        {formatScore(row.delta)}
      </td>
      <td className="result-col-num result-total">{formatScore(row.total)}</td>
    </tr>
  );
}

/**
 * Counts down locally from the duration the server sent. Working in elapsed
 * time from arrival rather than against a server timestamp keeps this immune
 * to clock skew between the two machines.
 */
function useCountdown(durationMs: number | null): number | null {
  const [remaining, setRemaining] = useState<number | null>(durationMs);
  const startedAt = useRef(Date.now());

  useEffect(() => {
    if (durationMs === null) {
      setRemaining(null);
      return;
    }
    startedAt.current = Date.now();
    setRemaining(durationMs);

    const id = setInterval(() => {
      const left = durationMs - (Date.now() - startedAt.current);
      setRemaining(left > 0 ? left : 0);
      if (left <= 0) clearInterval(id);
    }, 100);
    return () => clearInterval(id);
  }, [durationMs]);

  return remaining;
}

function verdictTone(viewerWon: boolean | null): string {
  if (viewerWon === null) return 'result-verdict-neutral';
  return viewerWon ? 'result-verdict-win' : 'result-verdict-loss';
}

function joinNames(names: readonly string[]): string {
  if (names.length === 0) return 'Nobody';
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

/** Tricks-basis scores carry tenths for overtricks; whole numbers stay clean. */
function formatScore(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
