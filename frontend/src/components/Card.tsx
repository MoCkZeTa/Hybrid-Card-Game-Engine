import type { MaskedCard } from '@hcg/shared';

const SUIT_SYMBOL: Record<string, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };
const COURT_RANKS = new Set(['J', 'Q', 'K']);

export type CardSize = 'sm' | 'md' | 'lg';

/**
 * Pip layout for the number cards, as `[x, y]` in the unit square: x is
 * 0 = left column, 0.5 = centre, 1 = right column; y is 0 = top row,
 * 1 = bottom row. These are the traditional arrangements you'd find on a real
 * deck — CSS maps them onto the card's inner area, so one table drives every
 * card size.
 */
const PIP_LAYOUTS: Record<string, readonly (readonly [number, number])[]> = {
  '2': [[0.5, 0], [0.5, 1]],
  '3': [[0.5, 0], [0.5, 0.5], [0.5, 1]],
  '4': [[0, 0], [1, 0], [0, 1], [1, 1]],
  '5': [[0, 0], [1, 0], [0.5, 0.5], [0, 1], [1, 1]],
  '6': [[0, 0], [1, 0], [0, 0.5], [1, 0.5], [0, 1], [1, 1]],
  '7': [[0, 0], [1, 0], [0.5, 0.25], [0, 0.5], [1, 0.5], [0, 1], [1, 1]],
  '8': [[0, 0], [1, 0], [0.5, 0.25], [0, 0.5], [1, 0.5], [0.5, 0.75], [0, 1], [1, 1]],
  '9': [
    [0, 0], [1, 0],
    [0, 0.333], [1, 0.333],
    [0.5, 0.5],
    [0, 0.667], [1, 0.667],
    [0, 1], [1, 1],
  ],
  T: [
    [0, 0], [1, 0],
    [0.5, 0.1667],
    [0, 0.333], [1, 0.333],
    [0, 0.667], [1, 0.667],
    [0.5, 0.833],
    [0, 1], [1, 1],
  ],
};

export function PlayingCard({
  card,
  size = 'md',
  playable = false,
  onClick,
  title,
}: {
  card: MaskedCard;
  size?: CardSize;
  playable?: boolean;
  onClick?: () => void;
  title?: string;
}): JSX.Element {
  if (card === 'HIDDEN') {
    return (
      <div className={`card card-${size} card-back`} aria-label="Hidden card">
        <span className="card-back-crest" aria-hidden="true">
          ♠
        </span>
      </div>
    );
  }

  const rank = card.slice(0, -1);
  const suit = card.slice(-1);
  const displayRank = rank === 'T' ? '10' : rank;
  const symbol = SUIT_SYMBOL[suit] ?? suit;

  const className = [
    'card',
    `card-${size}`,
    // One ink colour per suit rather than the usual red/black pair: clubs are
    // green, so ♠ and ♣ don't read as the same glyph at corner-pip size.
    suit in SUIT_SYMBOL ? `card-suit-${suit}` : '',
    playable ? 'card-playable' : '',
    onClick ? 'card-clickable' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const content = (
    <>
      <span className="card-corner card-corner-tl" aria-hidden="true">
        <span className="card-rank">{displayRank}</span>
        <span className="card-mini-suit">{symbol}</span>
      </span>

      <span className="card-face-art" aria-hidden="true">
        {rank === 'A' ? (
          <span className="card-ace">{symbol}</span>
        ) : COURT_RANKS.has(rank) ? (
          <span className="card-court">
            <span className="card-court-letter">{rank}</span>
            <span className="card-court-suit">{symbol}</span>
          </span>
        ) : (
          <PipField rank={rank} symbol={symbol} />
        )}
      </span>

      <span className="card-corner card-corner-br" aria-hidden="true">
        <span className="card-rank">{displayRank}</span>
        <span className="card-mini-suit">{symbol}</span>
      </span>
    </>
  );

  const label = title ?? `${displayRank} of ${suitName(suit)}`;

  if (onClick) {
    return (
      <button type="button" className={className} onClick={onClick} title={title} aria-label={label}>
        {content}
      </button>
    );
  }

  return (
    <div className={className} title={title} role="img" aria-label={label}>
      {content}
    </div>
  );
}

/** The suit pips of a number card, laid out per `PIP_LAYOUTS`. */
function PipField({ rank, symbol }: { rank: string; symbol: string }): JSX.Element | null {
  const layout = PIP_LAYOUTS[rank];
  if (!layout) return null;
  return (
    <span className="card-pips">
      {layout.map(([x, y], i) => (
        <span
          key={i}
          // Pips below the midline sit upside down, exactly as they do on a
          // real deck so the card reads the same from either end.
          className={`card-pip ${y > 0.5 ? 'card-pip-inverted' : ''}`}
          style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
        >
          {symbol}
        </span>
      ))}
    </span>
  );
}

function suitName(suit: string): string {
  return { S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' }[suit] ?? suit;
}
