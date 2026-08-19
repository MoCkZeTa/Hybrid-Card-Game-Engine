import { useState } from 'react';
import type { AuthUser, BotLevel, RoomState } from '@hcg/shared';
import { seatPosition } from './seat-layout';

const BOT_LEVELS: readonly { value: BotLevel; label: string }[] = [
  { value: 'easy', label: 'Easy' },
  { value: 'medium', label: 'Medium' },
  { value: 'hard', label: 'Hard' },
  { value: 'extreme', label: 'Extremely Hard' },
];

/**
 * Shown right after CREATE_MATCH (host) or after pasting a match ID (a
 * friend joining) — every seat laid out open. Nobody is dealt in yet: clicking
 * a seat just claims it, and the match only actually deals + hands unclaimed
 * seats to bots once the host taps "Start match".
 */
export function Room({
  matchId,
  room,
  user,
  connected,
  onClaimSeat,
  onStart,
  onLeave,
}: {
  matchId: string;
  room: RoomState;
  user: AuthUser;
  connected: boolean;
  onClaimSeat: (seat: number) => void;
  onStart: (botLevel?: BotLevel) => void;
  onLeave: () => void;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const [botLevel, setBotLevel] = useState<BotLevel>(room.defaultBotLevel);
  const isHost = room.hostUserId === user.id;
  const youveGotASeat = room.seats.some((s) => s.userId === user.id);
  const claimedCount = room.seats.filter((s) => s.userId !== null).length;
  const hostSeat = room.seats.find((s) => s.userId === room.hostUserId);
  const emptySeatCount = room.playerCount - claimedCount;

  async function copyMatchId(): Promise<void> {
    await navigator.clipboard.writeText(matchId);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
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
            <span className="chip-label">Game</span>
            {room.gameDisplayName}
          </span>
          <span className="chip">
            <span className="chip-label">Seated</span>
            {claimedCount}/{room.playerCount}
          </span>
          <span className="chip">
            <span className="chip-label">Rounds</span>
            {room.maxHands}
          </span>
        </div>
        <div className="app-bar-right">
          <span className={connected ? 'conn-dot conn-on' : 'conn-dot conn-off'} />
          <span className="app-bar-user">{user.displayName}</span>
        </div>
      </header>

      <button
        className="match-id room-match-id"
        title={`${matchId} — click to copy, share with friends so they can join`}
        onClick={() => void copyMatchId()}
      >
        Match ID <code>{matchId}</code> {copied ? 'Copied' : 'Copy'}
      </button>

      <div className="table-surface room-surface">
        <span className="surface-mark" aria-hidden="true">
          ♠
        </span>

        <div className="room-seats">
          {room.seats.map((seat, i) => {
            const isYou = seat.userId === user.id;
            const isOpen = seat.userId === null;
            return (
              <button
                key={seat.seat}
                style={seatPosition(i, room.playerCount)}
                className={`room-plate ${isOpen ? 'room-plate-open' : ''} ${isYou ? 'room-plate-you' : ''}`}
                disabled={!isOpen && !isYou}
                onClick={() => onClaimSeat(seat.seat)}
              >
                <span className="room-plate-seat">Seat {seat.seat}</span>
                <span className="room-plate-name">
                  {isOpen ? 'Tap to sit' : (seat.displayName ?? `Player ${seat.seat}`)}
                </span>
                {isYou && <span className="room-plate-tag">You</span>}
                {seat.userId === room.hostUserId && !isYou && <span className="room-plate-tag">Host</span>}
              </button>
            );
          })}
        </div>

        <div className="room-center">
          {isHost ? (
            <>
              <span className="room-center-title">{youveGotASeat ? 'Ready when you are' : 'Pick your seat'}</span>
              {emptySeatCount > 0 && (
                <div className="room-bot-level-picker" role="radiogroup" aria-label="Bot difficulty">
                  {BOT_LEVELS.map((l) => (
                    <button
                      key={l.value}
                      type="button"
                      role="radio"
                      aria-checked={botLevel === l.value}
                      className={`btn btn-sm ${botLevel === l.value ? 'btn-primary' : 'btn-ghost'}`}
                      onClick={() => setBotLevel(l.value)}
                    >
                      {l.label}
                    </button>
                  ))}
                </div>
              )}
              <button
                className="btn btn-primary btn-lg"
                disabled={!connected}
                onClick={() => onStart(emptySeatCount > 0 ? botLevel : undefined)}
              >
                Start match
              </button>
              <span className="room-center-hint">
                {emptySeatCount > 0
                  ? `${emptySeatCount} empty seat${emptySeatCount === 1 ? '' : 's'} will be played by bots`
                  : 'Everyone is seated'}
              </span>
              {emptySeatCount > 0 && (
                <span className="room-center-note">Harder bots take longer to respond.</span>
              )}
            </>
          ) : (
            <>
              <span className="room-center-title">{youveGotASeat ? "You're in" : 'Pick your seat'}</span>
              <span className="room-center-hint">
                Waiting for {hostSeat?.displayName ?? 'the host'} to start the match…
              </span>
            </>
          )}
        </div>
      </div>

      <p className="section-sub room-footer-note">
        Share the match ID above with your friends — they paste it into "Join a match" in the
        lobby and tap an open seat here. Any seat still empty when the host starts is played by a
        bot, and if anyone disconnects mid-match, a bot takes over their seat until they reconnect.
      </p>
    </div>
  );
}
