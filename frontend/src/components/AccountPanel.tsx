import { useEffect, useState, type FormEvent } from 'react';
import type { AuthUser } from '@hcg/shared';
import { changePassword, fetchSessionCount, logoutEverywhere } from '../api';

/** Mirrors the server's own minimum (`auth-service.ts`). */
const MIN_PASSWORD_LENGTH = 8;

/**
 * Account settings: change your password, see how many sessions the account has
 * open, and end them.
 *
 * All three endpoints already existed on the server and had no caller at all —
 * a feature is not shipped if the only way to reach it is curl.
 *
 * The session count is the part worth having. It is the only signal a player
 * gets that someone else is signed in as them, and it is what makes "sign out
 * everywhere" a decision rather than a guess.
 */
export function AccountPanel({
  user,
  token,
  onClose,
  onSessionEnded,
}: {
  user: AuthUser;
  token: string;
  onClose: () => void;
  /** This browser's own session was deliberately revoked — drop back to sign-in. */
  onSessionEnded: () => void;
}): JSX.Element {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sessions, setSessions] = useState<number | null>(null);

  // Load on open, and re-load after anything that changes the number.
  const [sessionsNonce, setSessionsNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void fetchSessionCount(token)
      .then((count) => {
        if (!cancelled) setSessions(count);
      })
      // A failed count is not worth an error banner over the password form,
      // which is the reason people actually open this panel.
      .catch(() => {
        if (!cancelled) setSessions(null);
      });
    return () => {
      cancelled = true;
    };
  }, [token, sessionsNonce]);

  async function handleChangePassword(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (next !== confirm) {
      setError("Those two passwords don't match");
      return;
    }
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await changePassword(token, current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      // The server keeps *this* session and revokes the rest, so the user stays
      // signed in here — say that, because "password changed" alone leaves them
      // wondering whether their phone is still logged in.
      setNotice('Password changed. Any other device signed in as you has been signed out.');
      setSessionsNonce((n) => n + 1);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSignOutOthers(): Promise<void> {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await logoutEverywhere(token, true);
      setNotice('Signed out on every other device. This one is still signed in.');
      setSessionsNonce((n) => n + 1);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSignOutEverywhere(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      await logoutEverywhere(token, false);
      // Our own token is dead now; staying on this screen would just produce
      // 401s on the next thing the player touches.
      onSessionEnded();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h3>Account</h3>
        <p className="account-identity">
          Signed in as <strong>{user.displayName}</strong> — {user.email}
        </p>

        <div className="account-sessions">
          <span>
            {sessions === null
              ? 'Active sessions unavailable'
              : sessions === 1
                ? 'This is the only device signed in.'
                : `${sessions} devices are signed in to this account.`}
          </span>
          <div className="account-session-actions">
            <button className="btn btn-sm" type="button" onClick={() => void handleSignOutOthers()} disabled={busy}>
              Sign out other devices
            </button>
            <button
              className="btn btn-sm btn-danger"
              type="button"
              onClick={() => void handleSignOutEverywhere()}
              disabled={busy}
            >
              Sign out everywhere
            </button>
          </div>
        </div>

        <form className="auth-form" onSubmit={(e) => void handleChangePassword(e)}>
          <label>
            <span>Current password</span>
            <input
              type="password"
              required
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
            />
          </label>
          <label>
            <span>New password</span>
            <input
              type="password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              value={next}
              onChange={(e) => setNext(e.target.value)}
              placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
              autoComplete="new-password"
            />
          </label>
          <label>
            <span>Confirm new password</span>
            <input
              type="password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
          </label>

          {error && <div className="auth-error">{error}</div>}
          {notice && !error && (
            <div className="auth-notice" style={{ marginBottom: 0 }} role="status">
              {notice}
            </div>
          )}

          <div className="modal-actions">
            <button className="btn" type="button" onClick={onClose} disabled={busy}>
              Close
            </button>
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? 'Working…' : 'Change password'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
