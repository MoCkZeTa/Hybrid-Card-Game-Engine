import { useState, type FormEvent } from 'react';
import type { AuthSuccess } from '@hcg/shared';
import { login, register } from '../api';

type Mode = 'login' | 'register';

export function AuthScreen({
  onAuthenticated,
  notice,
}: {
  onAuthenticated: (result: AuthSuccess) => void;
  /** Why the player is here involuntarily — an expired session, typically. */
  notice?: string | null;
}): JSX.Element {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = mode === 'login' ? await login(email, password) : await register(email, password, displayName);
      onAuthenticated(result);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-hero">
        <div className="auth-hero-suits" aria-hidden="true">
          <span className="suit-s">♠</span>
          <span className="suit-h">♥</span>
          <span className="suit-d">♦</span>
          <span className="suit-c">♣</span>
        </div>
        <h1>Hybrid Card Game</h1>
        <p>Play 29, Callbreak and more against strategic AI opponents — or bring in your own game as a plugin.</p>
        <span className="auth-hero-tag" aria-hidden="true">♣</span>
      </div>

      <div className="auth-panel">
        <div className="auth-form-wrap">
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

            {error && <div className="auth-error">{error}</div>}

            <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
              {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
