import { useState, type FormEvent } from 'react';
import type { AuthSuccess } from '@hcg/shared';
import { resetPassword } from '../api';
import { AuthShell } from './AuthShell';

/** Mirrors the server's own minimum (`auth-service.ts`), so the form can say so before a round trip. */
const MIN_PASSWORD_LENGTH = 8;

/**
 * Where the emailed reset link lands: `/reset-password?token=…`.
 *
 * Rendered by `App` **before** the signed-in check, and deliberately so — the
 * whole point of a reset is that you couldn't get in, and a page that demanded
 * a session first would be useless to the only people who need it.
 *
 * On success the server signs the user in immediately (it returns a real
 * `AuthSuccess`), which saves making someone who just proved control of the
 * mailbox type the password they only invented ten seconds ago.
 */
export function ResetPassword({
  token,
  onAuthenticated,
  onDone,
}: {
  /** Read from the query string by the caller; empty when the link was mangled. */
  token: string;
  onAuthenticated: (result: AuthSuccess) => void;
  /** Clears `/reset-password` from the address bar and returns to the app. */
  onDone: () => void;
}): JSX.Element {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    // Checked here rather than server-side because the server has no second
    // field to compare against — this one exists purely to catch a typo in a
    // password nobody can see themselves type.
    if (password !== confirm) {
      setError("Those two passwords don't match");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const result = await resetPassword(token, password);
      // Order matters: sign in first, then rewrite the URL. `onDone` navigates
      // away from a token that is now spent, so a refresh can't retry it.
      onAuthenticated(result);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // A link that arrived without a token is not a form to fill in — say so
  // rather than letting someone type a password into something that cannot work.
  if (!token) {
    return (
      <AuthShell>
        <div className="auth-form">
          <h2 className="auth-heading">This link is incomplete</h2>
          <p className="auth-lede">
            The reset link didn't carry a token. Email clients sometimes break long links across lines — try
            copying the whole thing into the address bar, or request a new one.
          </p>
          <button className="btn btn-primary btn-block" type="button" onClick={onDone}>
            Back to sign in
          </button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <form className="auth-form" onSubmit={(e) => void handleSubmit(e)}>
        <h2 className="auth-heading">Choose a new password</h2>
        <p className="auth-lede">
          Signing in everywhere else will be cancelled — if someone else had your account, this is what removes
          them.
        </p>

        <label>
          <span>New password</span>
          <input
            type="password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
            autoComplete="new-password"
            autoFocus
          />
        </label>

        <label>
          <span>Confirm new password</span>
          <input
            type="password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Type it again"
            autoComplete="new-password"
          />
        </label>

        {error && <div className="auth-error">{error}</div>}

        <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Set new password'}
        </button>
        <button className="btn btn-ghost btn-block" type="button" onClick={onDone} disabled={busy}>
          Cancel
        </button>
      </form>
    </AuthShell>
  );
}
