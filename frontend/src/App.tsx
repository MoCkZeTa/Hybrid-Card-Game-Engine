import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuthSuccess, AuthUser, BotLevel } from '@hcg/shared';
import { WS_URL, clearToken, fetchMe, getStoredToken, logout, storeToken } from './api';
import { useGameConnection } from './useGameConnection';
import { AuthScreen } from './components/AuthScreen';
import { Lobby } from './components/Lobby';
import { Room } from './components/Room';
import { GameTable } from './components/GameTable';
import { ResetPassword } from './components/ResetPassword';
import { AccountPanel } from './components/AccountPanel';

/**
 * The only client-side route in the app.
 *
 * A password-reset email links here cold, so this path has to resolve before
 * anything else runs — including the signed-in check, since not being able to
 * sign in is the entire reason someone follows that link. Vite's dev server and
 * `static-files.ts` in production both fall back to index.html for it.
 *
 * Read once at module load rather than on every render: nothing here navigates,
 * and `handleResetDone` rewrites the URL with `replaceState` precisely so a
 * spent token cannot be replayed by a refresh.
 */
const RESET_PATH = '/reset-password';
const initialPath = window.location.pathname;
const initialResetToken = new URLSearchParams(window.location.search).get('token') ?? '';


export default function App(): JSX.Element {
  const [token, setToken] = useState<string | null>(() => getStoredToken());
  const [user, setUser] = useState<AuthUser | null>(null);
  const [restoring, setRestoring] = useState(true);
  // Explains an involuntary return to the sign-in screen. Only set when the
  // session died under the player — never when they signed out themselves.
  const [signInNotice, setSignInNotice] = useState<string | null>(null);
  const [showAccount, setShowAccount] = useState(false);
  // Left once the reset screen is finished with, so the app renders normally
  // without a full page load.
  const [onResetRoute, setOnResetRoute] = useState(initialPath === RESET_PATH);
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

  // `persist` is the sign-in form's "Keep me signed in" box. Defaulting it to
  // false matters for the callers that don't pass it — `ResetPassword` signs
  // you in straight after a reset, and a password reset is what you do when the
  // account may be compromised, so quietly persisting that session to the
  // browser is the wrong default.
  const handleAuthenticated = useCallback((result: AuthSuccess, persist = false) => {
    storeToken(result.token, persist);
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

  const handleResetDone = useCallback(() => {
    // Strip the token from the address bar. It is single-use and already spent
    // on success; on cancel it should not sit in history either.
    window.history.replaceState({}, '', '/');
    setOnResetRoute(false);
  }, []);

  // Ending every session on purpose — the account panel's "sign out
  // everywhere". Same teardown as a normal sign-out, minus the logout call the
  // server has already performed.
  const handleSessionEnded = useCallback(() => {
    setShowAccount(false);
    clearToken();
    setToken(null);
    setUser(null);
    setSignInNotice('Signed out on all devices. Please sign in again.');
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

  if (onResetRoute) {
    return (
      <ResetPassword token={initialResetToken} onAuthenticated={handleAuthenticated} onDone={handleResetDone} />
    );
  }

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
          onOpenAccount={() => setShowAccount(true)}
          onRefreshGames={conn.refreshGames}
        />
      )}

      {showAccount && (
        <AccountPanel
          user={user}
          token={token}
          onClose={() => setShowAccount(false)}
          onSessionEnded={handleSessionEnded}
        />
      )}
    </div>
  );
}
