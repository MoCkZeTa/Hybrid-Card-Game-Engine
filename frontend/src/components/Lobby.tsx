import { useEffect, useRef, useState } from 'react';
import type { AuthUser, GameSummary } from '@hcg/shared';
import { deletePlugin, fetchPluginSource, type PluginSource } from '../api';
import { ImportPlugin } from './ImportPlugin';
import { GameDesigner } from './GameDesigner';

/** Whether opening the plugin panel saves over the original or beside it. */
type EditIntent = 'edit' | 'copy';

/**
 * The game list is whatever the server reports from its loaded plugins —
 * nothing about a specific game is hardcoded here, including how many players
 * it takes. Table sizes come from each plugin's declared range.
 */
export function Lobby({
  games,
  user,
  token,
  connected,
  onCreate,
  onEnterRoom,
  onSignOut,
  onOpenAccount,
  onRefreshGames,
}: {
  games: readonly GameSummary[];
  user: AuthUser;
  token: string;
  connected: boolean;
  onCreate: (gameId: string, playerCount: number, maxHands: number) => void;
  onEnterRoom: (matchId: string) => void;
  onSignOut: () => void;
  onOpenAccount: () => void;
  onRefreshGames: () => void;
}): JSX.Element {
  const [selectedGame, setSelectedGame] = useState<string | null>(null);
  const [playerCount, setPlayerCount] = useState<number | null>(null);
  const [maxHands, setMaxHands] = useState<number | null>(null);
  const [joinMatchId, setJoinMatchId] = useState('');
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<{ source: PluginSource; intent: EditIntent } | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const importPanelRef = useRef<HTMLDivElement | null>(null);

  const active = games.find((g) => g.gameId === selectedGame) ?? null;
  const effectiveCount = playerCount ?? active?.defaultPlayerCount ?? 4;
  const effectiveHands = maxHands ?? active?.handLimit.defaultValue ?? 1;

  // Land on the first game rather than an empty detail pane — there is nothing
  // useful to show in the "nothing selected" state, and it's the larger half of
  // the screen.
  useEffect(() => {
    if (selectedGame !== null || games.length === 0) return;
    setSelectedGame(games[0]!.gameId);
    setPlayerCount(games[0]!.defaultPlayerCount);
    setMaxHands(games[0]!.handLimit.defaultValue);
  }, [games, selectedGame]);

  async function openPlugin(gameId: string, intent: EditIntent): Promise<void> {
    setEditError(null);
    try {
      const source = await fetchPluginSource(token, gameId);
      setEditTarget({ source, intent });
    } catch (err) {
      setEditError((err as Error).message);
    }
  }

  // The panel sits at the bottom of the right-hand column, well below the game
  // list on anything but a tall screen — so opening it from a row would
  // otherwise fill a form the player cannot see. Scroll it into view whenever
  // it opens pre-filled, honouring a reduced-motion preference.
  useEffect(() => {
    if (!editTarget) return;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    importPanelRef.current?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  }, [editTarget]);

  async function confirmDelete(gameId: string): Promise<void> {
    setDeleteError(null);
    try {
      await deletePlugin(token, gameId);
      if (selectedGame === gameId) setSelectedGame(null);
      onRefreshGames();
    } catch (err) {
      setDeleteError((err as Error).message);
    } finally {
      setPendingDelete(null);
    }
  }

  return (
    <div className="lobby">
      <header className="app-bar">
        <div className="app-bar-brand">
          <span className="app-bar-logo">♠</span>
          <span>Hybrid Card Game</span>
        </div>
        <div className="app-bar-right">
          <span className={connected ? 'conn-dot conn-on' : 'conn-dot conn-off'} />
          <button className="app-bar-user" onClick={onOpenAccount} title="Account settings">
            {user.displayName}
          </button>
          <button className="btn btn-ghost" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </header>

      <div className="lobby-grid">
        <section className="lobby-col">
          <div className="lobby-head">
            <h2>Choose a game</h2>
            <span className="section-sub" style={{ margin: 0 }}>
              {games.length === 0 ? 'Loading…' : `${games.length} from plugins`}
            </span>
          </div>

          {deleteError && <div className="inline-error">{deleteError}</div>}
          {editError && <div className="inline-error">{editError}</div>}

          <div className="game-list">
            {games.map((game) => (
              <div key={game.gameId} className={`game-row ${selectedGame === game.gameId ? 'game-row-active' : ''}`}>
                <button
                  className="game-row-hit"
                  onClick={() => {
                    setSelectedGame(game.gameId);
                    setPlayerCount(game.defaultPlayerCount);
                    setMaxHands(game.handLimit.defaultValue);
                  }}
                >
                  <div className="game-row-main">
                    <span className="game-row-name">{game.displayName}</span>
                    <span className="game-row-meta">
                      {formatCounts(game.playerCounts)} players · {trumpLabel(game.trumpMode)}
                    </span>
                  </div>
                </button>
                <div className="game-row-actions">
                  {game.imported ? (
                    <span className="badge-imported">imported</span>
                  ) : (
                    <span className="badge-builtin" title="Ships with the server — read-only">
                      built-in
                    </span>
                  )}
                  {/* Only a game you own gets a pencil. That glyph means "edit
                      in place" everywhere else in the app, and on a built-in
                      the server would refuse the save. */}
                  {game.imported && (
                    <button
                      className="icon-btn"
                      title={`Edit ${game.displayName}`}
                      onClick={() => void openPlugin(game.gameId, 'edit')}
                    >
                      <PencilIcon />
                    </button>
                  )}
                  {/* Copy works on anything: it opens the same panel pre-filled
                      and saves beside the original rather than over it — the
                      only way to customise a read-only built-in, and the safe
                      way to try a variant of a game of your own. */}
                  <button
                    className="icon-btn"
                    title={
                      game.imported
                        ? `Copy ${game.displayName} to a new game — this one stays as it is`
                        : `Make your own copy of ${game.displayName} — the built-in stays as it ships`
                    }
                    onClick={() => void openPlugin(game.gameId, 'copy')}
                  >
                    <CopyIcon />
                  </button>
                  {/* A built-in gets no delete affordance either, for the same
                      reason: a button that always fails is worse than none. */}
                  {game.imported && (
                    <button
                      className="icon-btn icon-btn-danger"
                      title={`Delete ${game.displayName}`}
                      onClick={() => setPendingDelete(game.gameId)}
                    >
                      <TrashIcon />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="lobby-col-tail">
            <h2 className="section-title">Join a match</h2>
            <p className="section-sub">Got a match ID from a friend? Paste it in to open the room and pick a seat.</p>
            <div className="panel panel-row">
              <label className="field field-grow">
                <span>Match ID</span>
                <input value={joinMatchId} onChange={(e) => setJoinMatchId(e.target.value)} placeholder="paste match id" />
              </label>
              <button
                className="btn btn-primary"
                disabled={!connected || !joinMatchId}
                onClick={() => onEnterRoom(joinMatchId)}
              >
                Join room
              </button>
            </div>
          </div>
        </section>

        <section className="lobby-col">
          {active ? (
            <div className="game-detail">
              <div className="game-detail-top">
                <div>
                  <span className="kicker">Selected game</span>
                  <h3>{active.displayName}</h3>
                  <div className="game-detail-tags">
                    <span className={`tag tag-${active.trumpMode}`}>{trumpLabel(active.trumpMode)}</span>
                    {active.hasBidding && <span className="tag">Bidding</span>}
                    <span className="tag">{active.topology === 'fixed-pairs' ? 'Pairs' : 'Solo'}</span>
                  </div>
                </div>
              </div>

              <dl className="game-detail-stats">
                <div>
                  <dt>Players</dt>
                  <dd>{formatCounts(active.playerCounts)}</dd>
                </div>
                <div>
                  <dt>Cards each</dt>
                  <dd>{active.handSizeByCount[String(effectiveCount)] ?? '—'}</dd>
                </div>
                <div>
                  <dt>Teams</dt>
                  <dd>{active.topology === 'fixed-pairs' ? 'Pairs' : 'Solo'}</dd>
                </div>
              </dl>

              {active.playerCounts.length > 1 && (
                <label className="field">
                  <span>Table size</span>
                  <div className="seat-picker">
                    {active.playerCounts.map((n) => (
                      <button
                        key={n}
                        className={`seat-chip ${effectiveCount === n ? 'seat-chip-active' : ''}`}
                        onClick={() => setPlayerCount(n)}
                      >
                        {n} players
                      </button>
                    ))}
                  </div>
                </label>
              )}

              <label className="field">
                <span>Rounds</span>
                <div className="round-picker">
                  <button
                    className="btn btn-ghost round-step"
                    disabled={effectiveHands <= active.handLimit.min}
                    onClick={() => setMaxHands(Math.max(active.handLimit.min, effectiveHands - 1))}
                    aria-label="One fewer round"
                  >
                    −
                  </button>
                  <input
                    className="round-input"
                    type="number"
                    min={active.handLimit.min}
                    max={active.handLimit.max}
                    value={effectiveHands}
                    onChange={(e) => {
                      // Clamp on the way in so the control can never offer a
                      // value the server would reject.
                      const next = Number(e.target.value);
                      if (!Number.isFinite(next)) return;
                      setMaxHands(
                        Math.min(active.handLimit.max, Math.max(active.handLimit.min, Math.round(next))),
                      );
                    }}
                    aria-label="Number of rounds"
                  />
                  <button
                    className="btn btn-ghost round-step"
                    disabled={effectiveHands >= active.handLimit.max}
                    onClick={() => setMaxHands(Math.min(active.handLimit.max, effectiveHands + 1))}
                    aria-label="One more round"
                  >
                    +
                  </button>
                </div>
                <small className="field-hint">
                  {effectiveHands === active.handLimit.defaultValue
                    ? `${active.displayName}'s usual length.`
                    : `Default is ${active.handLimit.defaultValue}.`}
                </small>
              </label>

              <ul className="game-detail-rules">
                <li>{trumpRule(active.trumpMode)}</li>
                <li>
                  {active.hasBidding
                    ? 'Every player bids before the hand is played.'
                    : 'No bidding — the first trick starts straight away.'}
                </li>
                <li>
                  {active.topology === 'fixed-pairs'
                    ? 'Partners sit opposite each other and score as a team.'
                    : 'Everyone plays and scores for themselves.'}
                </li>
              </ul>

              <p className="section-sub" style={{ margin: 0 }}>
                You'll pick your seat in the room that opens next — nobody is dealt in until you (the
                host) click "Start match" there, and empty seats are filled by bots at that point.
              </p>

              <button
                className="btn btn-primary btn-lg"
                disabled={!connected}
                onClick={() => onCreate(active.gameId, effectiveCount, effectiveHands)}
              >
                Create match
              </button>
            </div>
          ) : (
            <div className="game-detail game-detail-empty">
              <span className="game-detail-empty-mark" aria-hidden="true">
                ♦
              </span>
              <p style={{ margin: 0 }}>Pick a game on the left to see its details and start a match.</p>
            </div>
          )}

          <div className="lobby-col-tail" ref={importPanelRef}>
            <h2 className="section-title">Add a game</h2>
            {/* Designer first: describing a game is the lower-effort path in,
                and it renders nothing at all on a server with no LLM key, so
                the import panel stays the top control there. */}
            <GameDesigner token={token} onPublished={onRefreshGames} />
            {/* The key carries the intent as well as the id: the panel seeds
                its form state from these props once, so copying a plugin you
                already have open for editing has to remount it to re-seed. */}
            <ImportPlugin
              key={editTarget ? `${editTarget.intent}:${editTarget.source.gameId}` : 'new'}
              token={token}
              editing={editTarget?.source ?? null}
              intent={editTarget?.intent ?? 'edit'}
              onImported={onRefreshGames}
              onDoneEditing={() => setEditTarget(null)}
            />
          </div>
        </section>
      </div>

      {pendingDelete && (
        <div className="modal-backdrop" onClick={() => setPendingDelete(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Delete this game?</h3>
            {(() => {
              // Only imported games reach this modal — built-ins have no delete
              // button, so there is no shipped-files case left to warn about.
              const target = games.find((g) => g.gameId === pendingDelete);
              return (
                <p>
                  <strong>{target?.displayName ?? pendingDelete}</strong> will be removed from the server. This
                  can't be undone — you'd need to import it again. Matches already in progress keep playing.
                </p>
              );
            })()}
            <div className="modal-actions">
              <button className="btn" onClick={() => setPendingDelete(null)}>
                Cancel
              </button>
              <button className="btn btn-danger" onClick={() => void confirmDelete(pendingDelete)}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** "4" for a fixed game, "3–6" for a contiguous range, "3, 5, 7" otherwise. */
function formatCounts(counts: readonly number[]): string {
  if (counts.length === 0) return '—';
  if (counts.length === 1) return String(counts[0]);
  const contiguous = counts.every((n, i) => i === 0 || n === counts[i - 1]! + 1);
  return contiguous ? `${counts[0]}–${counts[counts.length - 1]}` : counts.join(', ');
}

function trumpRule(mode: GameSummary['trumpMode']): string {
  if (mode === 'hidden') return 'Trump is set face-down and only revealed once someone calls for it.';
  if (mode === 'static') return 'Trump is the same suit in every hand.';
  return 'The winning bidder names the trump suit.';
}

function trumpLabel(mode: GameSummary['trumpMode']): string {
  if (mode === 'hidden') return 'Hidden trump';
  if (mode === 'static') return 'Fixed trump';
  return 'Bid trump';
}

function PencilIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M13.5 3.5 16.5 6.5 6.5 16.5H3.5V13.5L13.5 3.5Z" strokeLinejoin="round" />
    </svg>
  );
}

/** Two stacked sheets — "duplicate this", as distinct from the pencil's "change this". */
function CopyIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <rect x="7" y="7" width="9.5" height="9.5" rx="1.5" strokeLinejoin="round" />
      <path d="M13 4.5H4.5a1 1 0 0 0-1 1V13" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TrashIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M4 6h12M8 6V4h4v2M6 6l.6 10h6.8L14 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
