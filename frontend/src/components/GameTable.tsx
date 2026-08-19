import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuthUser, CardId, LegalMove, MaskedCard, MaskedGameState, MaskedPlayerState, TrickCard } from '@hcg/shared';
import { PlayingCard } from './Card';
import { BidPicker } from './BidPicker';
import { ResultModal } from './ResultModal';
import { seatPosition } from './seat-layout';

const SUIT_SYMBOL: Record<string, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };

// Bridge ordering (♠ ♥ ♦ ♣), ascending rank within suit — reads left-to-right
// the way most players expect a fanned hand to be sorted.
const SUIT_SORT: Record<string, number> = { S: 0, H: 1, D: 2, C: 3 };
const RANK_SORT = '23456789TJQKA';

function sortHand(hand: readonly MaskedCard[]): MaskedCard[] {
  return [...hand].sort((a, b) => {
    if (a === 'HIDDEN' || b === 'HIDDEN') return 0;
    const suitDiff = (SUIT_SORT[a.slice(-1)] ?? 9) - (SUIT_SORT[b.slice(-1)] ?? 9);
    if (suitDiff !== 0) return suitDiff;
    return RANK_SORT.indexOf(a.slice(0, -1)) - RANK_SORT.indexOf(b.slice(0, -1));
  });
}

// How long the completed trick lingers on the table before it's swept away.
// Long enough to register the winning card, short enough not to stall play.
const TRICK_LINGER_MS = 1600;

/** Unit vector from the centre of the surface out toward a seat, for throwing cards to and from it. */
function seatVector(seat: number, viewerSeat: number, total: number): { dx: number; dy: number } {
  const angle = Math.PI / 2 + (((seat - viewerSeat + total) % total) / total) * Math.PI * 2;
  return { dx: Math.cos(angle), dy: Math.sin(angle) };
}

/**
 * Which seat took the trick that just resolved — the one whose tricksWon went
 * up. Returns null if no seat's count moved (a game that scores by card points
 * rather than tricks, or the very first state after a reconnect, where there is
 * nothing to diff against); the caller then plays a plain fade instead of
 * sweeping the cards to a seat.
 */
function winningSeat(
  trick: readonly TrickCard[],
  players: readonly MaskedPlayerState[],
  before: ReadonlyMap<number, number>,
): number | null {
  if (before.size === 0) return null;
  for (const { seat } of trick) {
    const prev = before.get(seat);
    const now = players.find((p) => p.seat === seat)?.tricksWon;
    if (prev !== undefined && now !== undefined && now > prev) return seat;
  }
  return null;
}

/** "seat-2" -> that player's name; "team-0"/"team-1" -> "Team 1"/"Team 2" (no per-team roster is on the wire, just a friendlier label than the raw key). */
function scoreLabel(key: string, players: readonly MaskedPlayerState[]): string {
  const seatMatch = key.match(/^seat-(\d+)$/);
  if (seatMatch) {
    const seat = Number(seatMatch[1]);
    return players.find((p) => p.seat === seat)?.name ?? key;
  }
  const teamMatch = key.match(/^team-(\d+)$/);
  if (teamMatch) return `Team ${Number(teamMatch[1]) + 1}`;
  return key;
}

export function GameTable({
  state,
  matchId,
  viewerSeat,
  user,
  connected,
  onPlayMove,
  onLeave,
}: {
  state: MaskedGameState;
  matchId: string;
  viewerSeat: number;
  user: AuthUser;
  connected: boolean;
  onPlayMove: (moveId: string) => void;
  onLeave: () => void;
}): JSX.Element {
  const me = state.players.find((p) => p.seat === viewerSeat);
  const total = state.players.length;
  const isMyTurn = state.turnSeat === viewerSeat && state.legalMoves.length > 0;
  const isOver = state.phase === 'SCORING';

  // The result popup is keyed by which result it is, so dismissing round 2's
  // popup doesn't also suppress round 3's — and the next hand's state (which
  // clears lastResult) reopens the flow naturally.
  const result = state.lastResult;
  const resultKey = result === null ? null : `${result.scope}-${result.handNumber}`;
  const [dismissedResult, setDismissedResult] = useState<string | null>(null);
  const showResult = resultKey !== null && resultKey !== dismissedResult;

  // The engine clears currentTrick back to [] in the very same state
  // transition that plays the 4th card, so the server never actually emits a
  // state where all cards are visible — the client would otherwise jump
  // straight from 3 cards to 0 and the winning card is never seen. `lastTrick`
  // (the just-completed trick, sent alongside the now-empty currentTrick)
  // gives the client something to freeze and sweep away instead.
  const [visibleTrick, setVisibleTrick] = useState<readonly TrickCard[]>(state.currentTrick);
  const [trickResolving, setTrickResolving] = useState(false);
  const [trickWinner, setTrickWinner] = useState<number | null>(null);
  // Pixel offset from the trick pile to the winning seat's tile, measured off
  // the live DOM rather than assumed from the layout — the seats are a
  // responsive strip, so their real positions are the only reliable target.
  const [sweep, setSweep] = useState<{ x: number; y: number } | null>(null);
  const lingerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seenLastTrickRef = useRef<readonly TrickCard[] | null>(null);
  const seatRefs = useRef(new Map<number, HTMLElement>());
  const trickRef = useRef<HTMLDivElement | null>(null);

  const registerSeat = useCallback((seat: number, el: HTMLElement | null) => {
    if (el) seatRefs.current.set(seat, el);
    else seatRefs.current.delete(seat);
  }, []);

  // Nothing on the wire names the seat that took the trick, but exactly one
  // seat's tricksWon goes up when one resolves — so the delta across states
  // identifies the winner without touching the protocol. Held in a ref that is
  // refreshed *after* the trick effect below, so that effect still sees the
  // pre-trick counts.
  const prevTricksRef = useRef<ReadonlyMap<number, number>>(new Map());

  // The AI only waits ~550ms between turns, so when it wins a trick and leads
  // the next one, the server can emit that next card well before the ~1.6s
  // sweep animation below finishes — a human winner, by contrast, takes long
  // enough clicking their next card that the animation always completes first.
  // That's the entire reason the sweep used to read as smooth for a human
  // winner and clipped for an AI one. Fix: hold the latest trick data in a
  // ref and re-sync from it once the animation's own timer fires, instead of
  // reacting to every state change immediately — so a fast-arriving next
  // trick queues behind the animation rather than cutting it off.
  const latestTrickRef = useRef({ currentTrick: state.currentTrick, lastTrick: state.lastTrick, players: state.players });

  const syncTrick = useCallback(() => {
    const { currentTrick, lastTrick, players } = latestTrickRef.current;

    if (currentTrick.length > 0) {
      // A trick is actively being played — show it live, no lingering.
      setTrickResolving(false);
      setTrickWinner(null);
      setSweep(null);
      setVisibleTrick(currentTrick);
      return;
    }

    const last = lastTrick;
    const alreadySeen =
      last !== null &&
      seenLastTrickRef.current !== null &&
      last.length === seenLastTrickRef.current.length &&
      last.every((tc, i) => tc.seat === seenLastTrickRef.current![i]?.seat && tc.card === seenLastTrickRef.current![i]?.card);

    if (last !== null && !alreadySeen) {
      const winner = winningSeat(last, players, prevTricksRef.current);
      seenLastTrickRef.current = last;
      setVisibleTrick(last);
      setTrickResolving(true);
      setTrickWinner(winner);
      setSweep(measureSweep(trickRef.current, winner === null ? undefined : seatRefs.current.get(winner)));
      lingerTimerRef.current = setTimeout(() => {
        lingerTimerRef.current = null;
        // Re-sync against whatever's arrived since, rather than blindly
        // clearing — a new trick may already be under way.
        syncTrick();
      }, TRICK_LINGER_MS);
    } else if (!lingerTimerRef.current) {
      setVisibleTrick([]);
      setTrickResolving(false);
    }
  }, []);

  useEffect(() => {
    latestTrickRef.current = { currentTrick: state.currentTrick, lastTrick: state.lastTrick, players: state.players };
    // An animation is already in flight (sweep or its post-linger hold) — let
    // its own timer re-sync when it completes instead of interrupting it here.
    if (lingerTimerRef.current) return;
    syncTrick();
  }, [state.currentTrick, state.lastTrick, state.players, syncTrick]);

  // Must run after the effect above, which reads the previous counts.
  useEffect(() => {
    prevTricksRef.current = new Map(state.players.map((p) => [p.seat, p.tricksWon]));
  }, [state.players]);

  useEffect(
    () => () => {
      if (lingerTimerRef.current) clearTimeout(lingerTimerRef.current);
    },
    [],
  );

  // Rotate the seat order so the viewer is always first, then drop them —
  // opponents read left-to-right in turn order from the viewer's left.
  const ordered = Array.from({ length: total }, (_, i) => state.players[(viewerSeat + i) % total]!);
  const opponents = ordered.slice(1);

  // Card plays render on the hand itself. Bids get a compact stepper instead
  // of one button per number (a 13-option bid was a wall of buttons — see
  // BidPicker). Everything else (trump choice, the standalone reveal-trump
  // move, pass) stays as a plain button.
  const cardMoves = new Map<CardId, LegalMove>();
  const bidMoves: LegalMove[] = [];
  const otherMoves: LegalMove[] = [];
  for (const move of state.legalMoves) {
    const playAction = move.actions.find((a) => a.type === 'PLAY_CARD');
    const bidAction = move.actions.length === 1 && move.actions[0]!.type === 'PLACE_BID' ? move.actions[0] : null;
    if (playAction && move.actions.length === 1) cardMoves.set(playAction.card, move);
    else if (bidAction) bidMoves.push(move);
    else otherMoves.push(move);
  }

  return (
    <div className="game">
      <header className="app-bar">
        <div className="app-bar-brand">
          <button className="btn btn-ghost" onClick={onLeave}>
            ← Lobby
          </button>
        </div>
        <div className="app-bar-chips">
          <span className="chip">
            <span className="chip-label">Round</span>
            {state.handNumber}
            {state.totalHands === null ? '' : ` / ${state.totalHands}`}
          </span>
          <span className="chip">
            <span className="chip-label">Phase</span>
            {state.phase}
          </span>
          <span className="chip">
            <span className="chip-label">Trump</span>
            {state.trumpSuit === null
              ? '—'
              : state.trumpSuit === 'STATUS: HIDDEN'
                ? 'Hidden'
                : `${SUIT_SYMBOL[state.trumpSuit] ?? ''} ${state.trumpSuit}`}
          </span>
          <span className="chip">
            <span className="chip-label">Led</span>
            {/* Letter alongside the glyph, as the Trump chip does: these sit on
                the dark app bar, not on card stock, so the per-suit card inks
                can't carry ♠ vs ♣ apart here. */}
            {state.leadSuit === null
              ? '—'
              : `${SUIT_SYMBOL[state.leadSuit] ?? ''} ${state.leadSuit}`}
          </span>
        </div>
        <div className="app-bar-right">
          <span className={connected ? 'conn-dot conn-on' : 'conn-dot conn-off'} />
          <span className="app-bar-user">{user.displayName}</span>
        </div>
      </header>

      {/* Everyone sits on a ring across the felt — the viewer at bottom centre,
          the rest clockwise — with the trick in the middle. The felt is a plain
          textured surface rather than a drawn oval, which is what was squeezing
          the seats and the played cards into one narrow band. */}
      <div className="table-surface">
        <span className="surface-mark" aria-hidden="true">
          ♠
        </span>

        {ordered.map((p, i) => (
          <SeatTile
            key={p.seat}
            player={p}
            isTurn={state.turnSeat === p.seat}
            took={trickWinner === p.seat}
            isSelf={p.seat === viewerSeat}
            showCards={p.seat !== viewerSeat}
            position={seatPosition(i, total)}
            innerRef={(el) => registerSeat(p.seat, el)}
            scoringBasis={state.scoringBasis}
            handPoints={state.handPoints}
          />
        ))}

        {visibleTrick.length === 0 ? (
          <div className="trick-placeholder">{isOver ? 'Hand complete' : 'Waiting for the lead'}</div>
        ) : (
          <div
            ref={trickRef}
            className={`trick-cards ${trickResolving ? 'trick-cards-resolving' : ''} ${
              sweep === null ? '' : 'trick-cards-sweeping'
            }`}
            style={sweep === null ? undefined : ({ '--sweep-x': `${sweep.x}px`, '--sweep-y': `${sweep.y}px` } as React.CSSProperties)}
          >
            {visibleTrick.map((tc, i) => {
              const { dx, dy } = seatVector(tc.seat, viewerSeat, total);
              return (
                <div
                  key={tc.seat}
                  className={`trick-card ${trickResolving && tc.seat === trickWinner ? 'trick-card-won' : ''}`}
                  style={{ '--deal-dx': dx, '--deal-dy': dy, '--i': i } as React.CSSProperties}
                >
                  <PlayingCard card={tc.card} size="md" />
                  <span className="trick-card-seat">
                    {state.players.find((p) => p.seat === tc.seat)?.name ?? `Seat ${tc.seat}`}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="scoreboard">
        {Object.entries(state.teamScores).map(([key, score]) => (
          <div key={key} className="score-chip">
            <span className="score-key">{scoreLabel(key, state.players)}</span>
            <span className="score-value">{score}</span>
            {state.scoringBasis === 'points' && (
              <span className="score-live" title="Points captured this hand">
                +{state.handPoints[key] ?? 0}
              </span>
            )}
          </div>
        ))}
        <button
          className="match-id"
          title={`${matchId} — click to copy, share with friends so they can join`}
          onClick={() => void navigator.clipboard.writeText(matchId)}
        >
          Match <code>{matchId.slice(0, 8)}…</code> Copy
        </button>
      </div>

      {isOver && !showResult && (
        <button className="banner banner-done" onClick={() => setDismissedResult(null)}>
          {state.matchOver
            ? 'Match complete — tap to see the final result'
            : 'Round complete — tap to see the scores'}
        </button>
      )}

      <div className="my-area">
        <div className="my-head">
          <span className="my-head-label">Your hand</span>
          <span className={isMyTurn ? 'turn-pill turn-pill-active' : 'turn-pill'}>
            {isOver
              ? state.matchOver
                ? 'Match over'
                : 'Round over'
              : isMyTurn
                ? 'Your turn'
                : 'Waiting for others…'}
          </span>
        </div>

        {/* --hand-n lets the CSS fan the cards tighter as the hand grows, so a
            13-card hand stays on one row instead of wrapping. */}
        <div className="my-hand" style={{ '--hand-n': me?.hand.length ?? 0 } as React.CSSProperties}>
          {me && sortHand(me.hand).map((card, i) => {
            const move = card === 'HIDDEN' ? undefined : cardMoves.get(card);
            return (
              <PlayingCard
                key={`${card}-${i}`}
                card={card}
                size="lg"
                playable={Boolean(move)}
                onClick={move ? () => onPlayMove(move.id) : undefined}
                title={move?.label}
              />
            );
          })}
          {me?.hand.length === 0 && <span className="muted">No cards left</span>}
        </div>

        {bidMoves.length > 0 && <BidPicker moves={bidMoves} onBid={onPlayMove} />}

        {otherMoves.length > 0 && (
          <div className="action-buttons">
            {otherMoves.map((m) => (
              <button
                key={m.id}
                className={`btn ${m.tags?.includes('compound') || m.tags?.includes('reveals-trump') ? 'btn-warn' : 'btn-primary'}`}
                onClick={() => onPlayMove(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {showResult && result !== null && (
        <ResultModal
          result={result}
          viewerSeat={viewerSeat}
          viewerWon={state.viewerWon}
          nextRoundInMs={state.nextRoundInMs}
          onDismiss={() => setDismissedResult(resultKey)}
          onLeave={onLeave}
        />
      )}
    </div>
  );
}

/** Centre-to-centre offset from the trick pile to a seat tile, or null if either is missing. */
function measureSweep(trick: HTMLElement | null, seat: HTMLElement | undefined): { x: number; y: number } | null {
  if (!trick || !seat) return null;
  const a = trick.getBoundingClientRect();
  const b = seat.getBoundingClientRect();
  return { x: b.left + b.width / 2 - (a.left + a.width / 2), y: b.top + b.height / 2 - (a.top + a.height / 2) };
}

/** Overlapping face-down cards standing in for an opponent's concealed hand. */
function FaceDownFan({ count }: { count: number }): JSX.Element {
  const shown = Math.min(count, 5);
  return (
    <div className="fan" aria-label={`${count} cards`}>
      {Array.from({ length: shown }, (_, i) => (
        <div key={i} className="fan-card" style={{ marginLeft: i === 0 ? 0 : '-22px' }}>
          <PlayingCard card="HIDDEN" size="sm" />
        </div>
      ))}
    </div>
  );
}

function SeatTile({
  player,
  isTurn,
  took = false,
  isSelf = false,
  showCards = false,
  position,
  innerRef,
  scoringBasis,
  handPoints,
}: {
  player: MaskedPlayerState;
  isTurn: boolean;
  took?: boolean;
  isSelf?: boolean;
  showCards?: boolean;
  position: { top: string; left: string };
  innerRef?: (el: HTMLElement | null) => void;
  scoringBasis: MaskedGameState['scoringBasis'];
  handPoints: MaskedGameState['handPoints'];
}): JSX.Element {
  // In a points-scored game (29), an individual seat's trick count isn't a
  // meaningful number on its own — what the contract lives or dies on is the
  // partnership's combined card points. Swap in that shared, per-team number
  // instead, so both partners' tiles read the same live figure rather than
  // two disjoint trick counts that don't add up to anything the players are
  // actually chasing. A `solo` game (no `teamKey`) or a tricks-scored game
  // (Callbreak) keeps the original per-seat trick count.
  const showTeamPoints = scoringBasis === 'points' && player.teamKey !== null;

  return (
    <div
      ref={innerRef}
      style={position}
      className={`seat ${isTurn ? 'seat-turn' : ''} ${isSelf ? 'seat-self' : ''} ${took ? 'seat-took' : ''}`}
    >
      {showCards && <FaceDownFan count={player.handCount} />}
      <div className="seat-body">
        <div className="seat-name">
          {player.name}
          {player.isAI && <span className="plate-ai">AI</span>}
          {isSelf && <span className="plate-you">you</span>}
        </div>
        <div className="plate-stats">
          {showTeamPoints ? (
            <Stat
              label="pts"
              value={handPoints[player.teamKey!] ?? 0}
              title="Card points this seat's team has captured this hand"
            />
          ) : (
            <Stat label="won" value={player.tricksWon} title="Tricks won this hand" />
          )}
          <Stat
            label="bid"
            value={player.bid === null ? '—' : player.bid === -1 ? 'pass' : player.bid}
            title="Bid"
            highlight={player.bid !== null && player.bid !== -1}
          />
          <Stat label="left" value={player.handCount} title="Cards still in hand" />
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  title,
  highlight = false,
}: {
  label: string;
  value: number | string;
  title: string;
  highlight?: boolean;
}): JSX.Element {
  return (
    <span className={`stat ${highlight ? 'stat-live' : ''}`} title={title}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </span>
  );
}
