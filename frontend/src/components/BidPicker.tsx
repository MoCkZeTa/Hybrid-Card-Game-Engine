import { useEffect, useState } from 'react';
import type { LegalMove } from '@hcg/shared';

/**
 * A compact stepper for bidding, instead of one button per number.
 *
 * Callbreak alone can offer up to 13 bid options (more at some table
 * sizes/games) — rendering all of them as buttons was a wall of 13 identical
 * blue rectangles. A bid is a single number the player dials in, so a
 * stepper (or a "pass" button, when the game allows passing) is both more
 * compact and clearer about what's actually being chosen.
 */
export function BidPicker({ moves, onBid }: { moves: readonly LegalMove[]; onBid: (moveId: string) => void }): JSX.Element {
  const values = moves
    .map((m) => ({ move: m, value: (m.actions[0] as { value: number }).value }))
    .sort((a, b) => a.value - b.value);
  const min = values[0]!.value;
  const max = values[values.length - 1]!.value;

  const [selected, setSelected] = useState(min);

  // Keep the dial inside range if the legal set shifts (e.g. re-render with a new hand).
  useEffect(() => {
    setSelected((prev) => Math.min(Math.max(prev, min), max));
  }, [min, max]);

  const current = values.find((v) => v.value === selected) ?? values[0]!;

  return (
    <div className="bid-picker">
      <span className="bid-picker-label">Your bid</span>
      <div className="bid-stepper">
        <button
          className="bid-stepper-btn"
          disabled={selected <= min}
          onClick={() => setSelected((v) => Math.max(min, v - 1))}
          aria-label="Decrease bid"
        >
          −
        </button>
        <span className="bid-stepper-value">{selected}</span>
        <button
          className="bid-stepper-btn"
          disabled={selected >= max}
          onClick={() => setSelected((v) => Math.min(max, v + 1))}
          aria-label="Increase bid"
        >
          +
        </button>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={selected}
        onChange={(e) => setSelected(Number(e.target.value))}
        className="bid-slider"
      />
      {/*
        The engine's own label is used verbatim: it already knows whether the
        number means tricks (Callbreak) or card points (29), and whether this
        particular value is a raise or a seniority "Hold at N".
      */}
      <button className="btn btn-primary" onClick={() => onBid(current.move.id)}>
        {current.move.label}
      </button>
    </div>
  );
}
