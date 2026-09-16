# Authentication — how it actually works

> The complete auth story: registration, sign-in, sessions, the WebSocket handshake, password change and reset. Every design choice here has a reason, and the reasons are the point — a diff shows *what* the code does, this file is where *why* lives.
>
> Companions: `PROJECT_JOURNAL.md` (architecture at large), `PROBLEMS.md` (things that broke and why), `DEPLOYMENT.md` (what to configure).

---

## 0. The one decision everything else follows from

**Sessions are opaque random tokens stored in a database. Not JWTs.**

A JWT is self-verifying: the server checks a signature and trusts the contents, with no lookup. That is genuinely faster, and it is the wrong trade here, because a JWT **cannot be un-issued**. Once minted it is valid until it expires, and the only ways around that are a revocation blocklist (which is a database lookup — the exact cost you switched to JWTs to avoid) or very short expiry plus refresh tokens (which is a session store wearing a hat).

This is a game with long-lived tables. Three things had to work:

| Requirement | Why a token-in-database gives it | What a JWT would need |
|---|---|---|
| "Someone else is on my account — sign them out" | Delete the rows. Effective immediately | A blocklist, checked per request |
| Changing a password kills other sessions | Same | Same blocklist |
| A daily player is never signed out mid-hand | Sliding expiry — renew the row on use | Refresh-token machinery |

The cost of the choice is a database read per authentication. `SessionCache` (§4) buys most of that back.

**Corollary:** the token is a bearer credential with no structure. It carries no user id, no claims, no signature — it is 32 random bytes and means nothing except "some row in `hcg_sessions` has this string". Nothing can be inferred from it, and nothing can be forged into it.

---

## 1. The pieces

```
frontend/src/api.ts                REST client + token in localStorage
frontend/src/App.tsx               session restore, route gate, sign-out
frontend/src/components/           AuthScreen, ForgotPassword, ResetPassword, AccountPanel

backend/src/http/auth-routes.ts    the 9 HTTP endpoints, CORS, rate limiting
backend/src/core/auth/
  auth-service.ts                  all the policy — the file that matters
  password.ts                      scrypt hashing, verification, rehash detection
  user-repository.ts               storage interface + InMemory implementation
  mongo-user-repository.ts         Mongo implementation + indexes
  session-cache.ts                 read-through cache (InMemory | Redis)
  email-sender.ts                  Console | Resend | Null
backend/src/ws/ws-server.ts        the WebSocket AUTHENTICATE handshake
backend/src/ws/origin.ts           cross-site WebSocket hijacking defense
backend/src/core/ratelimit/        per-IP budgets, shared across the cluster
```

`AuthService` holds **all** the policy. The routes parse and serialise; the repositories store and fetch. Neither decides anything. That is why the same rules apply identically over HTTP and over the WebSocket, and why swapping Mongo for memory changes no behaviour.

### Storage shape

Three collections, namespaced `hcg_` so this project can share a database without colliding with another app's generic `users`:

| Collection | Holds | Indexes |
|---|---|---|
| `hcg_users` | id, email, displayName, passwordHash, createdAt | **unique** on `email` |
| `hcg_sessions` | token, userId, expiresAt | TTL on `expiresAt`, plus `userId` |
| `hcg_password_resets` | tokenHash, userId, expiresAt | TTL on `expiresAt`, plus `userId` |

The TTL indexes mean Mongo evicts expired sessions and reset tokens itself — there is no cleanup job to forget to run, and an expired row cannot linger and be used. The `userId` indexes exist because "revoke all my sessions" and "how many devices am I on" both scan by user, and without them that is a collection scan on the hottest collection in the system.

The unique index on `email` is not decoration. `register` checks for an existing account first, but check-then-insert is a race: two simultaneous registrations for the same address both see "no account" and both insert. The index makes uniqueness a **database guarantee**, and `register` catches Mongo's error code `11000` and turns it into the same friendly 409 the pre-check produces.

---

## 2. Registration

```
POST /api/auth/register  { email, password, displayName }  ->  { token, user, expiresAt }
```

1. **Normalize the email** (`normalizeEmail` — trim + lowercase). Everything downstream stores and looks up the normalized form, so `Ankit@Gmail.com` and `ankit@gmail.com` are one account rather than two.
2. **Validate.** Plausible email shape; password between **8 and 256** characters.
3. **Default the display name** to the local part of the email if blank.
4. **Check for an existing account** → 409.
5. **Hash the password** (§2.1).
6. **Insert**, catching `11000` as the race above.
7. **Issue a session** and return it — registration signs you straight in.

### Why the password has a *maximum* length

The minimum is obvious. The maximum is the interesting one: scrypt will hash an input of any size, and each attempt costs the server ~100ms of deliberately expensive CPU **regardless of input length**. An unbounded password field is therefore a free amplifier for an attacker — post a megabyte, make the server work. 256 characters is far beyond any real passphrase and closes it.

### 2.1 Password hashing

`node:crypto`'s **scrypt**. Deliberately not `bcrypt`: bcrypt is a native addon needing node-gyp and a C++ toolchain, which is a frequent source of install failures on Windows — this project's dev environment. scrypt is memory-hard, built in, and has no install risk.

Stored format:

```
scrypt$16384$<saltHex>$<derivedHex>
        ^^^^^ the cost parameter, stored inside the hash
```

**The cost lives in the hash, and that is the whole trick.** Raising `COST` in `password.ts` does nothing for accounts that already exist — their hashes keep verifying at the old cost forever, because the old cost is right there in the string. So `needsRehash()` compares the stored cost against the current one, and `login` upgrades the hash when it is weak:

```ts
if (needsRehash(user.passwordHash)) {
  await this.repository.updatePassword(user.id, await hashPassword(password));
}
```

A successful login is **the one moment the plaintext is legitimately in memory**, so it is the only moment an upgrade is possible. Accounts migrate to a stronger cost gradually, as their owners sign in, with nobody locked out and no migration script.

That rehash is wrapped in a `try`/`catch` that only logs. A failed *upgrade* must never turn a *valid login* into an error — the user typed the right password, and what happens to the hash afterwards is not their problem.

`verifyPassword` compares with `timingSafeEqual`, after a length check (it throws on mismatched lengths). A hash that cannot be parsed answers `needsRehash → true`: replacing something unreadable is strictly better than leaving it.

---

## 3. Sign-in

```
POST /api/auth/login  { email, password }  ->  { token, user, expiresAt }
```

```ts
const user = await this.repository.findByEmail(email);
if (!user) {
  await hashPassword(password);          // <- burn the CPU anyway
  throw new AuthError('Invalid email or password', 401);
}
if (!(await verifyPassword(password, user.passwordHash))) {
  throw new AuthError('Invalid email or password', 401);
}
```

Two anti-enumeration measures, and the second is the one people leave out:

- **Identical message** for "no such account" and "wrong password". Distinguishing them tells an attacker which addresses are registered, which is the first half of a credential-stuffing run.
- **Identical timing.** Without the `await hashPassword(password)` on the miss path, an unknown email returns in ~1ms and a known one in ~100ms — and that gap *is* the answer, no matter what the message says. Burning the same CPU closes a side channel the wording alone cannot.

### The rate-limit refund

`auth-routes.ts` spends one token from a per-IP bucket before login or register, then on **success**:

```ts
await rateLimiter.reset(loginBudgetKey);
```

Proving you own the account hands the whole budget back. An attacker gains nothing — they have no successful logins to spend — while a legitimate user who mistyped twice stops sharing a depleted bucket with everyone else behind the same NAT, office, or campus.

Budgets (`rate-limiter.ts`):

| Rule | Capacity | Refill | Why |
|---|---|---|---|
| `AUTH_RULE` | 10 | 1 per 6s | Login/register: ten quick tries, then slow |
| `PASSWORD_RESET_RULE` | 3 | 1 per 5 min | Far tighter — see below |

Reset is throttled ~30× harder than login because **its cost lands on someone else.** Every allowed request puts a real email in a real inbox. An unthrottled endpoint turns this server into a spam cannon aimed at whatever address the attacker types.

Only endpoints an *anonymous* caller can hammer are throttled. `/me`, `/logout` and `/change-password` all present a token the caller already holds; rate-limiting those would punish a client reconnecting after a network blip and stop no attack.

> Rate-limit counters live in Redis when it is configured. Without it they are per-process, so **N instances means N× the intended budget** — one of several reasons `REDIS_URL` matters for a real deploy.

---

## 4. Validating a token

Every authenticated request and every WebSocket handshake goes through:

```ts
async validateToken(token) {
  const cached = await this.cache?.get(token);
  if (cached !== undefined) return cached;        // hit (may be a cached null)
  const resolved = await this.lookupToken(token); // 2 DB reads
  await this.cache?.set(token, resolved);
  return resolved;
}
```

### The three-state cache

`SessionCache.get` returns `AuthUser | null | undefined`, and the distinction is load-bearing:

| Value | Meaning | Effect |
|---|---|---|
| `AuthUser` | Cached valid session | Serve it, no database |
| `null` | Cached **known-bad** token | Reject it, **no database** |
| `undefined` | Not cached | Ask the database |

Caching *negative* results is what stops a credential-stuffing flood becoming a database flood. Without it, every garbage token is two Mongo round-trips, and an attacker who can send 10,000 junk tokens a second has a denial-of-service on your database rather than a failed login attempt. This is why `undefined` and `null` had to be different values instead of a plain nullable.

Negative entries are cached for **10s**, positive ones for **60s**. Positives are held longer because they are the common case and are cheap to be slightly stale about; negatives are short because a token can go from invalid to valid (it can't, actually — but a *user* can be re-created, and short is free here).

That 60s is also the **blast radius of a lost invalidation.** Logout explicitly invalidates, but if that call fails, the ceiling on how long a revoked token keeps working is one TTL. The TTL is short *because* it is the backstop.

`RedisSessionCache` swallows every error and returns `undefined` on failure — **a cache that is down is a cache miss, never an auth failure.** Losing Redis makes the server slower, not broken.

### Sliding expiry

Inside `lookupToken`, on a cache miss only:

```ts
if (session.expiresAt.getTime() - Date.now() < SESSION_RENEW_AFTER_MS) {
  await this.repository.renewSession(token, new Date(Date.now() + SESSION_TTL_MS));
}
```

Sessions last **7 days** and renew once past their halfway point. Renewing on every request would be a database write per request; renewing only past halfway bounds it to roughly one write per 3.5 idle days. And because it sits *behind* the cache, an actively-used session costs at most one write per cache TTL rather than one per request.

A failed renewal is caught and logged, never thrown. The session is still valid *right now* — it just expires on its original schedule. Turning a transient write failure into a sign-out would be strictly worse than doing nothing.

---

## 5. The WebSocket handshake

The game runs over WebSocket, and the socket authenticates separately from the REST API. Two gates, in order:

### Gate 1 — Origin, at the HTTP upgrade

**The browser same-origin policy does not apply to WebSockets.** Any page on the internet can open `ws://your-server` from a victim's browser. `origin.ts` checks the `Origin` header against the allowlist built from `CORS_ORIGIN`, *before any socket state is allocated*.

Two deliberate holes:

- **No `Origin` header at all → allowed.** That is a non-browser client (CLI, `wscat`, load test). The entire threat model is "a victim's browser rides on the victim's session", which does not apply to someone running curl on their own machine with no victim's credentials to ride on.
- **Outside production, any `localhost:<port>` is allowed**, so Vite's port-hopping doesn't break local dev.

The second layer behind this: **the session token lives in `localStorage`, not a cookie.** A cross-site socket that somehow got past the origin check would still have nothing to authenticate with, because the browser does not attach `localStorage` to requests the way it attaches cookies. (The flip side: this makes CSRF a non-issue and XSS correspondingly more serious.)

> That choice has its own deep dive in **`SESSION_TRANSPORT.md`** — how cookies, bearer tokens and the hybrid refresh-cookie pattern each behave, why a WebSocket handshake is the worst place for a cookie, the five ways a socket can be authenticated, and the four reasons this project landed where it did. Read it before proposing a switch to cookie sessions.

### Gate 2 — `AUTHENTICATE`, as the first message

```
client → { type: 'AUTHENTICATE', token }
server → { type: 'AUTHENTICATED', userId, displayName }
```

Anything else before that gets `UNAUTHENTICATED — Send AUTHENTICATE before any other message`. A bad token gets an error **and a close with code `AUTH_FAILED` (4001)** — the close code is the important half, because `shouldReconnect(4001)` is false, and the client treats it as terminal rather than reconnecting forever with a token that will never work.

The close codes are a small protocol of their own:

| Code | Meaning | Client behaviour |
|---|---|---|
| `4000` GOING_AWAY | Server restarting | Reconnect shortly |
| `4001` AUTH_FAILED | Token bad — will stay bad | **Stop. Sign in again** |
| `4002` AUTH_TIMEOUT | No AUTHENTICATE in the window | Reconnect |
| `4003` HEARTBEAT_TIMEOUT | Connection is dead | Reconnect |
| `4004` POLICY_VIOLATION | Flooding, oversized message, too many connections | — |
| `4005` OVERLOADED | Server at capacity | Reconnect, long backoff |

### The per-account connection cap

After authenticating, the socket registers with `ConnectionRegistry` and gets back the account's **cluster-wide** connection count. Over the cap, the server **evicts the oldest sockets, not the newest** — the newest is the one the person is actually looking at.

The count deliberately comes from the registry rather than the local `peers` map: on a multi-node deploy this node holds only a fraction of the user's sockets, and counting locally would enforce a cap N× larger than configured. If sockets over the cap all belong to *other* nodes, this node cannot close them, so it refuses the newest instead — the wrong end, accepted knowingly, because the cap exists to contain a runaway reconnect loop and this stops that just as well.

---

## 6. Changing a password

```
POST /api/auth/change-password  (Bearer)  { currentPassword, newPassword }
```

1. Validate the session.
2. Verify `currentPassword` — a hijacked *session* must not be enough to take over the *account*.
3. Validate the new password's length.
4. **Reject a new password equal to the old one** — silently accepting a no-op change while telling the user they are now safe is worse than an error.
5. Write the new hash.
6. **Delete pending reset tokens** for the user. A live reset link is a credential for the old state of the account; a deliberate password change should kill it.
7. **Revoke every other session** — the caller's own survives.

Step 7 is the point of the whole endpoint. If the reason you are changing your password is "someone else got in", leaving their session alive defeats the exercise entirely. Keeping the caller's own session means the tab they did it in keeps working, which is the difference between a security feature and an annoyance.

---

## 7. Password reset

The longest path, and the one with the most ways to leak information.

```
POST /api/auth/forgot-password  { email }           -> { ok: true }   ALWAYS
POST /api/auth/reset-password   { token, password } -> { token, user, expiresAt }
```

### Requesting

```ts
const user = await this.repository.findByEmail(normalizeEmail(email));
if (!user) return;                                    // silent, indistinguishable
await this.repository.deletePasswordResetsForUser(user.id);   // one live link at a time
const token = randomBytes(32).toString('hex');
await this.repository.createPasswordReset({
  tokenHash: hashToken(token),                        // SHA-256 — see below
  userId: user.id,
  expiresAt: new Date(Date.now() + RESET_TTL_MS),     // 1 hour
});
```

Four things worth naming:

**The response is `{ok:true}` for an unknown address.** Anything else makes this endpoint a checker for which emails are registered. It answers identically, in the same time, whether or not the account exists.

**A send failure is logged, not thrown.** For the same reason: if a bad address produced an error and a good one produced success, the "always ok" response would be undone by the failure mode. Operators see `[auth] failed to send reset email` in the logs; the caller sees nothing. **This is why the `onboarding@resend.dev` sending-domain limit is dangerous** — it fails in exactly the way this code is designed to keep quiet. See `DEPLOYMENT.md` §5.

**Issuing a new link kills the old one.** Otherwise an older stolen email stays valuable indefinitely.

**The token is stored as SHA-256, not plaintext.** So a database dump contains no usable reset links.

> Plain SHA-256 here, scrypt for passwords — and that is not an inconsistency. The input is **32 bytes of cryptographic randomness**. There is no dictionary to run against it and no human pattern to exploit, so a deliberately slow hash buys nothing and costs latency. Slow hashing exists to defend *low-entropy* secrets. Using scrypt here would be cargo-culting.

The link is `${APP_BASE_URL}/reset-password?token=<the plaintext token>`. `APP_BASE_URL` is the **client's** origin, which is why it is a required production variable — unset, every reset email points at `localhost:5173`.

### Completing

```ts
const reset = await this.repository.findPasswordReset(hashToken(resetToken));
if (!reset) throw new AuthError('This reset link is invalid or has expired', 400);
assertPasswordAcceptable(newPassword);
const user = await this.repository.findById(reset.userId);
if (!user) throw new AuthError('This reset link is invalid or has expired', 400);

await this.repository.updatePassword(user.id, await hashPassword(newPassword));
await this.repository.deletePasswordResetsForUser(user.id);   // single use
await this.revokeSessions(user.id);                           // ALL of them
return this.issueSession(user);                               // sign them in
```

- **Expired and non-existent produce the same message.** "Expired" would confirm the address has an account.
- **Single use**, consumed whether or not anything after that point fails.
- **Every session dies — including any the legitimate user had.** A reset is what you do when you have lost control of the account, so the sessions already out there are precisely what you are trying to get rid of. There is no "keep current" option here, unlike `change-password`.
- **The user is signed in immediately.** They have just proved control of the mailbox and typed a new password; making them type it again ten seconds later is friction with no security value.

### The frontend half

Until recently this entire flow was **implemented on the server and unreachable** — the emailed link led to a dead route (`PROBLEMS.md`, "Production readiness"). What closes it:

- `App.tsx` checks `window.location.pathname === '/reset-password'` **before** the signed-in gate. Not being able to sign in is the entire reason someone follows that link, so gating the reset page behind a session would make it useless to the only people who need it.
- No router dependency — the project has none and needs none for one route.
- Vite's dev server and `static-files.ts` in production both fall back to `index.html`, so a **cold** URL resolves. Without that SPA fallback the link is a 404 and the feature is dead again.
- On success the returned `AuthSuccess` goes to the existing `handleAuthenticated`, then `history.replaceState` clears the token from the address bar — it is spent, and a refresh must not retry it.

---

## 8. The full journey

```
REGISTER / LOGIN  ──►  scrypt verify (+ rehash if weak)
                       ├─ create session row: 32 random bytes, +7 days
                       └─ token ──► localStorage 'hcg.token'
                                        │
        ┌───────────────────────────────┴───────────────────────────────┐
        ▼                                                               ▼
   HTTP: Authorization: Bearer <token>              WS: {type:'AUTHENTICATE', token}
        │                                                  │  (after the Origin check)
        └──────────────────► validateToken() ◄─────────────┘
                                   │
                     cache hit? ───┴─── miss → findSession → findById
                                                   └─ renew if past halfway
                                   │
                         ┌─────────┴─────────┐
                         ▼                   ▼
                    AuthUser              null → 401 / close 4001
```

Sign-out paths, and exactly what each one kills:

| Action | This session | Other sessions | Reset links |
|---|---|---|---|
| `logout` | ✗ killed | ✓ survive | ✓ survive |
| `logout-all` (keepCurrent) | ✓ survives | ✗ killed | ✓ survive |
| `logout-all` | ✗ killed | ✗ killed | ✓ survive |
| `change-password` | ✓ **survives** | ✗ killed | ✗ killed |
| `reset-password` | ✗ killed | ✗ killed | ✗ killed |
| 7 days idle | ✗ expires (Mongo TTL) | — | — |

`logout` invalidates the cache, deletes the row, **then invalidates again** — because a concurrent `validateToken` can re-populate the cache from the very row being deleted, in the window between the two operations.

---

## 9. The threat model, and what is deliberately not covered

Handled:

| Threat | Defense |
|---|---|
| Password database dump | scrypt, per-password salt, upgradeable cost |
| Reset token database dump | SHA-256 storage — no usable links |
| Account enumeration | Identical messages **and** identical timing on login; unconditional `{ok:true}` on reset |
| Credential stuffing | Per-IP budgets shared across the cluster; negative cache stops DB flooding |
| Using this server to spam a third party | Reset budget ~30× tighter than login |
| Cross-site WebSocket hijacking | Origin allowlist at the upgrade, plus token in `localStorage` not a cookie |
| Stolen session | Revocable in bulk; sliding 7-day expiry; `logout-all` |
| Stale reset link after a password change | Reset tokens deleted on change |
| Runaway reconnect loop | Cluster-wide per-account connection cap, oldest evicted first |
| Duplicate accounts on one email | Unique index, not a check-then-insert race |
| CPU amplification via huge passwords | 256-character maximum |

Not implemented, knowingly:

- **No email verification on registration.** You can sign up with an address you don't own. The consequence is bounded — that account's reset links go to the real owner, who can take it over — but a production deployment with real stakes should add it.
- **No 2FA.**
- **No account lockout after N failures.** Rate limiting is per-IP, not per-account, and that is deliberate: per-account lockout is itself a denial-of-service vector, since anyone who knows your email can lock you out of your own account.
- **No password strength rules beyond length.** Length is the honest signal; composition rules mostly produce `Passw0rd!`.
- **No audit log** of sign-ins, IPs, or devices. `/api/auth/sessions` returns a count, not a list — you can see *that* three devices are signed in, not *which*.

---

## 10. Endpoint reference

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| POST | `/api/auth/register` | — | `{email, password, displayName}` | `{token, user, expiresAt}` |
| POST | `/api/auth/login` | — | `{email, password}` | `{token, user, expiresAt}` |
| POST | `/api/auth/logout` | Bearer | — | `{ok:true}` |
| POST | `/api/auth/logout-all` | Bearer | `{keepCurrent?}` | `{ok:true}` |
| GET | `/api/auth/me` | Bearer | — | `AuthUser` \| 401 |
| GET | `/api/auth/sessions` | Bearer | — | `{count}` |
| POST | `/api/auth/change-password` | Bearer | `{currentPassword, newPassword}` | `{ok:true}` |
| POST | `/api/auth/forgot-password` | — | `{email}` | `{ok:true}` **always** |
| POST | `/api/auth/reset-password` | — | `{token, password}` | `{token, user, expiresAt}` |

Request bodies are capped at **8 KB**; anything larger is a 413 before parsing.

### Constants

| Constant | Value | Where |
|---|---|---|
| Session lifetime | 7 days, sliding | `auth-service.ts` |
| Session renew threshold | Past halfway (3.5 days) | `auth-service.ts` |
| Reset link lifetime | 1 hour, single use | `auth-service.ts` |
| Password length | 8–256 | `auth-service.ts` |
| scrypt cost `N` | 16384 (~100ms) | `password.ts` |
| Session cache TTL | 60s positive / 10s negative | `session-cache.ts` |
| Token entropy | 32 bytes, both session and reset | `auth-service.ts` |

---

## 11. Verifying it works

The whole flow was exercised against a live server on 2026-08-27 (`PROJECT_JOURNAL.md` §16). To repeat it:

```bash
# Console email sender — the reset link prints to the terminal, no mail needed.
cd backend && MONGODB_URI="" RESEND_API_KEY="" node dist/server.js
```

What to check, in order:

1. Register → you get a token.
2. `forgot-password` for a **real** and an **unknown** address → byte-identical `{ok:true}`, and **exactly one** email printed.
3. Reset with a 7-character password → rejected.
4. Reset with the emailed token → signs you in.
5. Reset with the **same token again** → `This reset link is invalid or has expired`.
6. `/me` with any pre-reset token → **401**.
7. Login with the old password → **401**; with the new one → 200.
8. `change-password` with the wrong current password → 401; correct → own session survives (200), other devices 401.
9. `logout-all {keepCurrent:true}` → this device 200, others 401; then `{keepCurrent:false}` → this device 401 too.

All nine were confirmed. Steps 5–7 are the ones worth re-running after any change to `AuthService` — they are the invariants that turn a reset from a password-change form into a security control.
