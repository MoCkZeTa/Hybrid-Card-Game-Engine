import { useState, type FormEvent } from 'react';
import { forgotPassword } from '../api';

/**
 * Requests a reset link.
 *
 * The one rule this screen has to hold: **it must answer the same way for a
 * registered address and an unknown one.** The server already does (it returns
 * `{ok:true}` regardless, see `auth-routes.ts`), and it does that so the
 * endpoint can't be used to find out which emails have accounts here. A UI that
 * helpfully said "no account with that address" would hand back the exact thing
 * the server is refusing to leak — so the success text below is deliberately
 * worded to promise nothing about whether an email was actually sent.
 */
export function ForgotPassword({ onBack }: { onBack: () => void }): JSX.Element {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await forgotPassword(email);
      setSent(true);
    } catch (err) {
      // Only transport and rate-limit failures reach here — a 429 is worth
      // showing, because the user really does need to wait before retrying.
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="auth-form">
        <h2 className="auth-heading">Check your email</h2>
        <p className="auth-lede">
          If an account exists for <strong>{email}</strong>, a link to choose a new password is on its way. It's
          good for one hour and can only be used once.
        </p>
        <p className="auth-lede">Nothing arrived? Check spam, then try again in a few minutes.</p>
        <button className="btn btn-primary btn-block" type="button" onClick={onBack}>
          Back to sign in
        </button>
      </div>
    );
  }

  return (
    <form className="auth-form" onSubmit={(e) => void handleSubmit(e)}>
      <h2 className="auth-heading">Reset your password</h2>
      <p className="auth-lede">Enter the email you signed up with and we'll send you a link to set a new password.</p>

      <label>
        <span>Email</span>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
          autoFocus
        />
      </label>

      {error && <div className="auth-error">{error}</div>}

      <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
        {busy ? 'Sending…' : 'Send reset link'}
      </button>
      <button className="btn btn-ghost btn-block" type="button" onClick={onBack} disabled={busy}>
        Back to sign in
      </button>
    </form>
  );
}
