# Session persistence — scope, silent restore, and the wrong-identity bug

> Where the session token *lives* in the browser, how long it outlives the page, and why this project moved from one browser-wide slot to a per-tab session with opt-in persistence.
>
> This is the third file in a set, and the boundaries matter:
>
> - `AUTH.md` — **what a session is.** An opaque token naming a row in `hcg_sessions`, why not a JWT, how it expires and renews.
> - `SESSION_TRANSPORT.md` — **how the token travels.** Cookies vs bearer tokens, CSRF vs XSS, why a cookie is worst on a WebSocket handshake, why the token is in Web Storage at all.
> - **This file** — **which storage, and for how long.** `SESSION_TRANSPORT.md` §3.1 lists `localStorage` / `sessionStorage` / in-memory in a three-row table and moves on, because that choice was orthogonal to the cookie question it was answering. This file is that table's missing argument.
>
> Read `SESSION_TRANSPORT.md` first if you have not. Nothing here reopens the cookie decision — the token remains a bearer token in Web Storage, and no `Set-Cookie` exists anywhere in the codebase.

---

## 0. The bug, as observed

Two accounts, two browsers, during ordinary playtesting:

1. `mockzeta` signed in and created a room.
2. `rahuljain` signed in and joined it.
3. `rahuljain`'s tab was closed.
4. The tab was reopened — and the app came up **signed in as `mockzeta`**.

No sign-in screen. No prompt. No error. The wrong identity, presented as if it were correct, with a live seat at a table.

Clearing `localStorage` fixed it immediately, which is what makes this worth a document rather than a commit message: the *fix* was obvious and the *cause* was not, and the code that produced it was, line by line, entirely correct.

### 0.1 What was verified as NOT the cause

Before changing anything, the whole path was audited and the server was tested live. All of it was sound:

| Suspected | Checked | Result |
|---|---|---|
| Token collision between users | `auth-service.ts:311` | `randomBytes(32)` — 256 bits, cannot collide |
| Login returning a shared session | `auth-routes.ts:86-96` | Delegates to `login()` → `issueSession()`, no shared state |
| Mongo session lookup missing its filter | `mongo-user-repository.ts:94` | `findOne({ _id: token })` — correctly filtered |
| Session cache keyed loosely | `session-cache.ts` | Keyed by full token, both implementations |
| Stale token captured in a socket reconnect closure | `useGameConnection.ts` deps `[wsUrl, token]` | Effect re-runs on token change; no stale capture |
| Two write paths for the token | grep for `localStorage` across `frontend/src` | Exactly one key, one writer |

And empirically, against the running server: two registrations produced distinct tokens, `/api/auth/me` resolved each to its own account, and a repeat login produced a third distinct token. **The server was never the problem.**

That is the important framing for everything below. This was not a defect in any function. It was a defect in a *property of the system* that no single function was responsible for.

---

## 1. Root cause: the session was a browser-wide singleton

The old storage layer was four lines and looked unimprovable:

```ts
const TOKEN_KEY = 'hcg.token';
export function getStoredToken()      { return localStorage.getItem(TOKEN_KEY); }
export function storeToken(token)     { localStorage.setItem(TOKEN_KEY, token); }
export function clearToken()          { localStorage.removeItem(TOKEN_KEY); }
```

Three properties of `localStorage` combine into the failure, and each is individually reasonable:

**1. It is scoped to the origin, not the tab.** Every tab on `localhost:5173` reads and writes the same slot. There is one session per browser, and the app has no way to express "this tab is Rahul".

**2. It holds exactly one value per key.** Signing in as a second account does not create a second session — it *overwrites* the first. The first account is not signed out, not warned, and not aware.

**3. It has no expiry of its own.** `localStorage` persists until code deletes it. The token inside it, meanwhile, is valid for **7 days with sliding renewal** (`auth-service.ts:31-33`) — every validation on a cache miss pushes the expiry out again. So an actively-used token is effectively immortal, and an abandoned one still has a week of life.

Compose them and you get the actual defect:

> **A token written days ago by a different person is still valid, still present, and is restored with no indication of whose it is.**

The restore path (`App.tsx:47-72`) does exactly what it was designed to do — read the stored token, ask `/api/auth/me` who it belongs to, adopt that identity — and every step succeeds. The server answers honestly: *this token belongs to mockzeta*. It was never asked the question the user cared about, which was "is this who I meant to be?"

### 1.1 Why it presented as "impossible"

The reported symptom included *"the token is the same in Brave and Chrome"*, which cannot happen — separate browsers have separate profiles and separate storage, and the probe proved the server never issues a token twice.

The likely truth is that both readings came from one browser, or from a tab where the key was absent and `null === null` read as "same". But chasing that is beside the point, and here is the lesson worth keeping:

**The design made an ordinary stale-token restore indistinguishable from an impossible cross-browser leak.** When identity is restored silently, the user has no way to observe *which* session they are in, so their bug report describes the symptom rather than the state. A design that surfaced the identity would have produced a report that diagnosed itself.

### 1.2 The second, quieter failure

Even with no stale tokens anywhere, the singleton makes this impossible:

> Sign in as two different accounts at the same time, in one browser.

Which is not an exotic request — it is what testing a multiplayer game *is*. The workaround people reach for is a second browser, and that is precisely the setup that produced the confusion above. The design pushed users toward the configuration most likely to confuse them.

---

## 2. The fix

The tab, not the browser, owns the session. Persistence beyond the tab is a thing the player asks for.

```
sessionStorage   authoritative, per-tab.   Survives reload. Dies with the tab.
localStorage     opt-in persistence only.  Consulted ONLY to seed a tab that
                 ("Keep me signed in")     has no session of its own.
```

`frontend/src/api.ts`:

```ts
export function getStoredToken(): string | null {
  const tabToken = readKey(sessionStorage);
  if (tabToken) return tabToken;

  const persisted = readKey(localStorage);
  if (persisted) writeKey(sessionStorage, persisted);   // adopt
  return persisted;
}

export function storeToken(token: string, persist: boolean): void {
  writeKey(sessionStorage, token);
  writeKey(localStorage, persist ? token : null);
}

export function clearToken(): void {
  writeKey(sessionStorage, null);
  writeKey(localStorage, null);
}
```

Three decisions in there are load-bearing and none is obvious.

### 2.1 Adopt-on-read is what makes the isolation hold

When a tab boots from the persisted slot it immediately copies the token into its own `sessionStorage`. Without that line, a tab seeded from `localStorage` would keep *re-reading* `localStorage` on every subsequent call — and any other tab signing in would move it underneath. Two tabs would drift back into sharing one slot and the singleton returns through the back door.

With the adopt, a tab is **pinned to an identity the moment it acquires one**. Nothing another tab does can move it. That is the property the whole design rests on.

### 2.2 Not persisting *clears* the shared slot

The subtle one. When `persist` is false the shared slot is emptied, not left alone.

The tempting alternative — "don't touch what I wasn't asked to touch" — reintroduces the original bug in full. Consider: `mockzeta` signs in with *Keep me signed in*. Later, `rahuljain` signs in without it. If the shared slot still holds `mockzeta`, then the next cold start restores `mockzeta`, silently, exactly as before.

The slot holds one token. Leaving a previous account's in it after signing in as someone else *guarantees* a future wrong-identity restore. So the rule is:

> **The persisted slot always reflects the most recent sign-in's intent — either filled by it, or emptied by it.**

The cost is honest and small: signing in without the box forgets a previously remembered account. That is a defensible reading of "don't keep me signed in", and it is strictly better than the alternative of a stale identity lying in wait.

### 2.3 Storage access is wrapped in try/catch

`sessionStorage` and `localStorage` **throw** rather than returning `null` in several real conditions: Safari private browsing, "block all cookies", enterprise policy, and partitioned third-party contexts. An unguarded `getItem` white-screens the app at module load, before React renders anything.

`readKey`/`writeKey` swallow it. A browser that refuses storage gets a session that does not outlive the page — degraded, not broken. This mirrors how the rest of the codebase treats optional infrastructure (`RedisSessionCache.get` returns "cache miss" rather than an auth failure when Redis is down; `SessionCache` docs, `REDIS.md`).

### 2.4 Reset-password does not persist

`handleAuthenticated(result, persist = false)` — the default matters. `ResetPassword` signs you in immediately after a reset and passes no flag. A password reset is what you do when the account may be compromised, quite possibly on a machine you do not own. Silently persisting *that* session to the browser is the wrong default, and now it takes an explicit argument to do so.

---

## 3. Behaviour matrix

Verified against the scenario suite (§5). "Was" is the old `localStorage`-only behaviour.

| Scenario | Was | Now |
|---|---|---|
| Reload a tab | signed in | signed in |
| Two accounts, two tabs | **second overwrites first** | each tab keeps its own |
| Close tab, open fresh one | **restored whoever was last** | signed out |
| Close tab, open fresh one, *Keep me signed in* was checked | signed in | signed in |
| Another tab signs in as someone else | **can move your session** | your tab is pinned |
| Sign in without *Keep me* while another account was remembered | **remembered account restored later** | shared slot emptied |
| Sign out | cleared | both tiers cleared |
| Browser blocks storage entirely | **white screen at load** | works, session ends with the page |

---

## 4. What this does and does not fix

Stated plainly, because the temptation with a fix like this is to overclaim.

**Fixed.** Two accounts in one browser. A closed tab cannot resurrect an identity. A stale token cannot be adopted without the player having explicitly asked for persistence. A hostile storage environment no longer breaks the boot.

**Not fixed — still true by design.** If you tick *Keep me signed in*, cold-start a tab, and that persisted token belongs to an account you have forgotten about, you are signed in as them without a prompt. That is what the checkbox *means*, and the mitigation is that it is now a deliberate act rather than the unavoidable default.

**Not addressed here.** Nothing in this change touches the XSS exposure of Web Storage (`SESSION_TRANSPORT.md` §3.3, §6.3). `sessionStorage` is exactly as readable by injected script as `localStorage` — that table's "XSS-readable: Yes" applies to both rows. The improvement is real but narrow: a token that does not outlive the tab is a token an attacker cannot exfiltrate *tomorrow*. It shortens the window; it does not close it.

**Also not addressed.** The gap in `SESSION_TRANSPORT.md` §8 stands unchanged — `AUTHENTICATE` happens once per socket and nothing revalidates a connection that stays open, so a socket can outlive a `logout-all`. Storage scope has no bearing on it.

---

## 5. Verifying it

The scenario suite lives at `scratchpad/storage-sim.mjs` (session-local, not committed). It models the three functions against fake `Storage` objects and asserts all seven scenarios in §3, including the two that regressed before:

```
node storage-sim.mjs
```

It is a *transcription* of the logic, not an import of the module (`api.ts` pulls in `import.meta.env` and will not load standalone), so it validates the design rather than the shipped bytes. If `api.ts`'s storage rules change, change it too — or better, if this area grows a third tier, promote it to a real test. The frontend workspace has no test suite today, which is why it is a script.

To check the live behaviour by hand, in DevTools on the app tab:

```js
console.log('tab:', sessionStorage.getItem('hcg.token')?.slice(0, 16) ?? 'NONE',
            '| persisted:', localStorage.getItem('hcg.token')?.slice(0, 16) ?? 'NONE');
```

Two tabs signed in as different accounts should print two different `tab:` values. `persisted:` is `NONE` unless somebody ticked the box.

---

## 6. Mistakes worth not repeating

- **Do not reintroduce a bare `localStorage.getItem` for the token.** It is the singleton, and it looks completely harmless at the call site. Go through `getStoredToken()`, which is the only thing that knows about the two tiers and the adopt.
- **Do not "optimise away" the adopt in §2.1.** It reads like a redundant write — the value is already in `localStorage`, why copy it — and removing it silently restores the cross-tab bug with no test failing and no visible symptom until two people are testing at once.
- **Do not make `persist` default to `true`** for convenience. Every caller that forgets to pass it then opts its user into browser-wide persistence, which inverts the entire point.
- **Do not treat "cleared the cache and it went away" as a diagnosis.** It was the correct *remedy* here and told us almost nothing about the *cause* — the code was right at every line, and the defect was in a system property. Clearing state destroys the evidence; capture it first (§5's snippet) if the symptom recurs.
- **Do not assume a symptom that "cannot happen" means the reporter is wrong.** The impossible-sounding detail (same token in two browsers) was a *consequence of the design being unobservable*, not a false report. That was the most useful signal available and it was nearly dismissed.
