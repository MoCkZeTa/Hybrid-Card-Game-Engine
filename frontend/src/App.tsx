import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuthSuccess, AuthUser, BotLevel } from '@hcg/shared';
import { clearToken, fetchMe, getStoredToken, logout, storeToken } from './api';
import { useGameConnection } from './useGameConnection';
import { AuthScreen } from './components/AuthScreen';
import { Lobby } from './components/Lobby';
import { Room } from './components/Room';
import { GameTable } from './components/GameTable';

const WS_URL = import.meta.env.VITE_WS_URL ?? 'ws://localhost:3001';

export default function App(): JSX.Element {
  const [token, setToken] = useState<string | null>(() => getStoredToken());
  const [user, setUser] = useState<AuthUser | null>(null);
  const [restoring, setRestoring] = useState(true);
  // Explains an involuntary return to the sign-in screen. Only set when the
  // session died under the player — never when they signed out themselves.
  const [signInNotice, setSignInNotice] = useState<string | null>(null);
  // Which matchId we've already sent ENTER_ROOM/JOIN for, so the auto-enter
  // effect below doesn't refire on every unrelated re-render.
  const enteredRef = useRef<string | null>(null);

  const conn = useGameConnection(WS_URL, token);

  // Restore a stored session on first load so a refresh doesn't sign you out.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = getStoredToken();
      if (!stored) {
        setRestoring(false);
        return;
      }
      const me = await fetchMe(stored);
      if (cancelled) return;
      if (me) {
        setUser(me);
        setToken(stored);
      } else {
        // The stored token no longer resolves — say so here, where it is cheap,
        // rather than letting the WebSocket discover it and raise an error.
        clearToken();
        setToken(null);
        setSignInNotice('Your session has expired. Please sign in again.');
      }
      setRestoring(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleAuthenticated = useCallback((result: AuthSuccess) => {
    storeToken(result.token);
    setToken(result.token);
    setUser(result.user);
    setSignInNotice(null);
  }, []);

  // The server refused our token (expired, or revoked from another device).
  // Reconnecting can't fix that, so drop the session and show the sign-in
  // screen rather than leaving the user on a table they can no longer play.
  useEffect(() => {
    if (!conn.sessionExpired) return;
    clearToken();
    setToken(null);
    setUser(null);
    setSignInNotice('Your session has expired. Please sign in again.');
    enteredRef.current = null;
  }, [conn.sessionExpired]);

  const handleSignOut = useCallback(() => {
    const current = getStoredToken();
    if (current) void logout(current);
    clearToken();
    setToken(null);
    setUser(null);
    setSignInNotice(null);
    enteredRef.current = null;
  }, []);

  const handleCreate = useCallback(
    (gameId: string, playerCount: number, maxHands: number) => {
      enteredRef.current = null;
      conn.createMatch(gameId, playerCount, maxHands);
    },
    [conn],
  );

  // Friend pasting a match ID: watch the room fill up, no seat picked yet.
  const handleEnterRoom = useCallback(
    (matchId: string) => {
      enteredRef.current = matchId;
      conn.enterRoom(matchId);
    },
    [conn],
  );

  // Picking/claiming a seat by clicking an open seat in the Room. `JOIN` is
  // idempotent server-side, so this doubles as the reconnect path: a player
  // whose socket dropped re-sends it and gets their seat back with a fresh
  // snapshot.
  const handleClaimSeat = useCallback(
    (matchId: string, seat: number) => {
      enteredRef.current = matchId;
      conn.claimSeat(matchId, seat);
    },
    [conn],
  );

  const handleStart = useCallback(
    (botLevel?: BotLevel) => {
      if (conn.matchId) conn.startMatch(conn.matchId, botLevel);
    },
    [conn],
  );

  const handleLeave = useCallback(() => {
    enteredRef.current = null;
    conn.leaveMatch();
  }, [conn]);

  // The host lands here right after CREATE_MATCH with no seat chosen yet —
  // auto-subscribe to room broadcasts so the Room screen has something to show.
  useEffect(() => {
    if (conn.matchId && conn.room === null && conn.state === null && enteredRef.current !== conn.matchId) {
      enteredRef.current = conn.matchId;
      conn.enterRoom(conn.matchId);
    }
  }, [conn, conn.matchId, conn.room, conn.state]);

  if (restoring) {
    return (
      <div className="boot">
        <div className="boot-spinner" />
      </div>
    );
  }

  if (!token || !user) {
    return <AuthScreen onAuthenticated={handleAuthenticated} notice={signInNotice} />;
  }

  const inRoom = conn.matchId !== null && conn.room !== null;
  const inTable = conn.matchId !== null && conn.state !== null;
  const tableViewerSeat = conn.state && conn.state.viewerSeat !== 'SPECTATOR' ? conn.state.viewerSeat : null;

  return (
    <div className={inRoom || inTable ? 'app app-play' : 'app'}>
      {(conn.status === 'reconnecting' || conn.status === 'offline') && (
        <div className={`link-banner link-banner-${conn.status}`} role="status" aria-live="polite">
          <span className="link-dot" />
          {conn.status === 'reconnecting' ? (
            <span>
              Connection lost — reconnecting
              {conn.reconnectAttempt > 1 ? ` (attempt ${conn.reconnectAttempt})` : ''}…
              <em> Your seat is being played by the house until you're back.</em>
            </span>
          ) : (
            <span>Disconnected. Reload the page to try again.</span>
          )}
        </div>
      )}

      {conn.lastError && (
        <div className="toast toast-error" role="alert">
          <div>
            <strong>{conn.lastError.code}</strong>
            <span>{conn.lastError.message}</span>
          </div>
          <button className="toast-close" onClick={conn.clearError} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {inRoom ? (
        <Room
          matchId={conn.matchId!}
          room={conn.room!}
          user={user}
          connected={conn.connected && conn.authenticated}
          onClaimSeat={(seat) => handleClaimSeat(conn.matchId!, seat)}
          onStart={handleStart}
          onLeave={handleLeave}
        />
      ) : inTable && tableViewerSeat !== null ? (
        <GameTable
          state={conn.state!}
          matchId={conn.matchId!}
          viewerSeat={tableViewerSeat}
          user={user}
          connected={conn.connected && conn.authenticated}
          onPlayMove={(moveId) => conn.submitMove(tableViewerSeat, moveId)}
          onLeave={handleLeave}
        />
      ) : (
        <Lobby
          games={conn.games}
          user={user}
          token={token}
          connected={conn.connected && conn.authenticated}
          onCreate={handleCreate}
          onEnterRoom={handleEnterRoom}
          onSignOut={handleSignOut}
          onRefreshGames={conn.refreshGames}
        />
      )}
    </div>
  );
}
