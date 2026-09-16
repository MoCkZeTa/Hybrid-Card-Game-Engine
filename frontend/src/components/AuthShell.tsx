import type { ReactNode } from 'react';

/**
 * The signed-out page chrome: hero on one side, a panel holding whatever form
 * you're showing on the other.
 *
 * Extracted because there are now three screens that live here — sign in,
 * forgot password, and choosing a new password from an emailed link — and the
 * hero markup was about to be copied into each of them. A reset page that has
 * drifted into looking like a different site is precisely the thing that makes
 * a password link feel like phishing.
 */
export function AuthShell({ children }: { children: ReactNode }): JSX.Element {
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
        <div className="auth-form-wrap">{children}</div>
      </div>
    </div>
  );
}
