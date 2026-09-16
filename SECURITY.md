# Security & Threat Model

> A centralized record of the project's security posture, known vulnerabilities, and threat model. Refer to `AUTH.md` and `DEPLOYMENT.md` for implementation details.

---

## 1. Threat Model (What is Covered)

| Threat | Defense |
|---|---|
| **Password database dump** | `scrypt` hashing, per-password salt, upgradeable cost |
| **Reset token database dump** | Tokens are stored as SHA-256 hashes, leaving no usable links in a dump |
| **Account enumeration** | Identical error messages **and** identical timing on login; unconditional `{ok:true}` on password reset request |
| **Credential stuffing** | Per-IP budgets shared across the cluster; negative session cache stops DB flooding |
| **Spamming via password reset** | Password reset rate limit is ~30× tighter than login limit |
| **Cross-site WebSocket hijacking** | Origin allowlist enforced at the HTTP upgrade; token stored in `localStorage` rather than an automatically-sent cookie |
| **Stolen session** | Revocable in bulk; sliding 7-day expiry; `logout-all` invalidates active sessions |
| **Stale reset link** | Reset tokens are aggressively deleted when a password is changed |
| **Runaway reconnect loop** | Cluster-wide per-account connection cap; oldest sockets evicted first |
| **Duplicate accounts** | Enforced via a strict unique index in MongoDB on normalized email |
| **CPU amplification via huge passwords** | Passwords capped at 256 characters |
| **Cross-Site Scripting (XSS)** | `Content-Security-Policy` (CSP) header enforced by the backend when serving static client files |

---

## 2. Threat Model (What is Deliberately NOT Covered)

These omissions are conscious trade-offs for UX or simplicity:

- **No email verification on registration:** A user can sign up with an address they don't own. (They cannot reset the password without access to the email).
- **No Two-Factor Authentication (2FA).**
- **No account lockout after N failures:** Rate limiting is enforced per-IP, not per-account, specifically to prevent attackers from locking out legitimate users via DoS.
- **No password strength rules:** Beyond the 8–256 character length constraint, no composition rules are enforced.
- **No audit log:** The system does not track sign-in IPs, locations, or devices — only the total count of active sessions.

---

## 3. Known Gaps & Action Items

### 3.1. Credentials Rotation
**Status: PENDING**
Several production secrets were previously held in plaintext (in chat logs or unencrypted `.env` files). These must be rotated manually by the repository owner:
- Groq API key
- MongoDB Atlas password
- Redis Cloud password
- Resend API key

### 3.2. Unencrypted Redis Traffic
**Status: RESOLVED**
Using `redis://` transmits session tokens and match states in clear text. `.env.example` now defaults to requiring `rediss://` for all production deployments.

### 3.3. XSS Exposure via LocalStorage
**Status: RESOLVED**
Since session tokens are stored in `localStorage` (a deliberate decision over HttpOnly cookies to prevent Cross-Site WebSocket Hijacking), the application is highly vulnerable to Cross-Site Scripting (XSS). A strict Content Security Policy (CSP) header is now injected when serving static files.

### 3.4. Rate Limit Spoofing
**Status: RESOLVED**
The rate limiter relies on `req.socket.remoteAddress` or `X-Forwarded-For`. If `TRUST_PROXY=true` is set without a real reverse proxy, an attacker can spoof the header and bypass rate limits. `TRUST_PROXY` defaults to `false` in `.env.example`.

### 3.5. Silent Email Failures
**Status: OPEN**
Until a custom sending domain is fully verified in Resend, the `onboarding@resend.dev` sender only delivers to the owner's email address. Password resets will silently fail for all other users.
