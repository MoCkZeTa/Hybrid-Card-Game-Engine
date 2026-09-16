import { useState, type FormEvent } from 'react';
import type { AuthSuccess } from '@hcg/shared';
import { login, register } from '../api';
import { AuthShell } from './AuthShell';
import { ForgotPassword } from './ForgotPassword';

type Mode = 'login' | 'register' | 'forgot';

export function AuthScreen({
  onAuthenticated,
  notice,
}: {
  onAuthenticated: (result: AuthSuccess, persist: boolean) => void;
  /** Why the player is here involuntarily — an expired session, typically. */
  notice?: string | null;
}): JSX.Element {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Off by default: the session is per-tab unless the player asks otherwise.
  // See `SESSION_PERSISTENCE.md` — an unchecked box is what keeps a stale token
  // from silently signing the next visitor in as somebody else.
  const [persist, setPersist] = useState(false);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = mode === 'login' ? await login(email, password) : await register(email, password, displayName);
      onAuthenticated(result, persist);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // The reset request replaces the whole panel rather than sitting under the
  // form: it is a different task, and leaving the sign-in fields visible
  // invites typing a password into a screen that is only asking for an address.
  if (mode === 'forgot') {
    return (
      <AuthShell>
        <ForgotPassword
          onBack={() => {
            setMode('login');
            setError(null);
          }}
        />
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      {notice && !error && (
        <div className="auth-notice" role="status">
          {notice}
        </div>
      )}

      <div className="auth-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={mode === 'login'}
          className={mode === 'login' ? 'auth-tab auth-tab-active' : 'auth-tab'}
          onClick={() => {
            setMode('login');
            setError(null);
          }}
        >
          Sign in
        </button>
        <button
          role="tab"
          aria-selected={mode === 'register'}
          className={mode === 'register' ? 'auth-tab auth-tab-active' : 'auth-tab'}
          onClick={() => {
            setMode('register');
            setError(null);
          }}
        >
          Create account
        </button>
      </div>

      <form className="auth-form" onSubmit={(e) => void handleSubmit(e)}>
        {mode === 'register' && (
          <label>
            <span>Display name</span>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="How others see you"
              autoComplete="nickname"
            />
          </label>
        )}

        <label>
          <span>Email</span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
          />
        </label>

        <label>
          <span>Password</span>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === 'register' ? 'At least 8 characters' : '••••••••'}
            autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
          />
        </label>

        <label className="auth-remember">
          <input type="checkbox" checked={persist} onChange={(e) => setPersist(e.target.checked)} />
          <span>
            Keep me signed in on this browser
            <small>Otherwise this session ends when you close the tab.</small>
          </span>
        </label>

        {error && <div className="auth-error">{error}</div>}

        <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>

        {mode === 'login' && (
          <button
            className="auth-link"
            type="button"
            onClick={() => {
              setMode('forgot');
              setError(null);
            }}
          >
            Forgot your password?
          </button>
        )}
      </form>
    </AuthShell>
  );
}
