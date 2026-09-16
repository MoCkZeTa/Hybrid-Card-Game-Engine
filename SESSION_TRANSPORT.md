# Session transport — cookies, bearer tokens, and WebSockets

> How a session credential physically travels between the browser and this server, what the alternatives are, and why this project carries a bearer token in `localStorage` instead of a cookie.
>
> `AUTH.md` answers *what a session is* — an opaque token naming a row in `hcg_sessions`, why not a JWT, how it expires and renews. This file answers the separate question of *how that token gets from the browser to the server on every request and every socket*, which is a different decision with a different set of tradeoffs. Read `AUTH.md` first if you have not.
>
> `SESSION_PERSISTENCE.md` answers the third question — *which* Web Storage the token sits in and how long it outlives the page. §3.1 below lists the options in a three-row table and moves on, because that choice was orthogonal to the cookie question; that file is the table's missing argument, and the record of the wrong-identity bug the original `localStorage`-only choice caused.
>
> Companions: `AUTH.md` (the auth system), `SESSION_PERSISTENCE.md` (storage scope), `DEPLOYMENT.md` (single-origin vs split-origin, `CORS_ORIGIN`), `PROBLEMS.md` (the cross-site WebSocket hijacking entry).

---

## 0. The question

Once a user has signed in and the server has handed back a token, something has to attach that token to every subsequent request. The browser gives you exactly two mechanisms:

1. **A cookie** — the browser stores it and attaches it *automatically*, forever, to matching requests.
2. **Anything else** — you store it yourself and attach it *manually*, in code.

Everything in this file follows from that one difference. Automatic attachment is the entire convenience of cookies and the entire source of their security problems, and the WebSocket handshake is where the two collide hardest.

---

## 1. What the transport actually has to do

Three jobs, and they are not equally hard:

| Job | Cookie | Bearer token |
|---|---|---|
| Survive a page refresh / browser restart | Free — the browser persists it | You call `localStorage.setItem` |
| Ride along on a REST call | Free — automatic | You add an `Authorization` header |
| Ride along on a **WebSocket** | Free — automatic, and that is the problem | You invent a mechanism (§5.6) |

Job 3 is where most of the design pressure lives, because the browser's `WebSocket` API is unusually restrictive about what you are allowed to send.

---

## 2. Option A — cookies

### 2.1 Mechanics

The server sets one on the sign-in response:

```
Set-Cookie: session=abc123; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800
```

From then on the browser attaches `Cookie: session=abc123` to every request whose URL matches the cookie's `Domain`/`Path` and whose context satisfies `SameSite`. The page's JavaScript is not involved and, with `HttpOnly`, cannot even see it.

The attributes are the whole security surface:

| Attribute | What it does | Why it matters |
|---|---|---|
| `HttpOnly` | `document.cookie` cannot read it | **The single biggest advantage over Web Storage.** An XSS payload can still *use* the session by making requests, but it cannot exfiltrate the token to another server |
| `Secure` | Only sent over HTTPS | Without it, a plain-HTTP request leaks the session in cleartext |
| `SameSite` | Whether it is sent on cross-site requests — see §2.3 | The difference between "CSRF is handled" and "CSRF is wide open" |
| `Domain` | Which hosts get it | Cookies are scoped by *domain*, not *origin* — `api.example.com` and `evil-subdomain.example.com` can share one |
| `Path` | Which URL prefixes get it | Weak isolation; not a security boundary |
| `Max-Age` / `Expires` | Persistence | Omitted = session cookie, dies with the tab |

### 2.2 What you get

- **XSS cannot steal the token.** `HttpOnly` is a genuine, browser-enforced guarantee that no amount of careful JavaScript can replicate.
- **Nothing to remember.** No storage code, no header code, no "did I attach it to this call" bugs. Every request is authenticated by construction, including ones you did not write — image tags, form posts, redirects.
- **The server can revoke by clearing it**, and the browser handles expiry.

### 2.3 What you pay: CSRF, and `SameSite`

Automatic attachment means *anyone* can make the browser send your cookie. A page on `evil.com` containing a hidden form that auto-submits a POST to `yourbank.com/transfer` produces a fully authenticated request, because the browser attaches the `yourbank.com` cookie to a request going to `yourbank.com` regardless of which page caused it. That is cross-site request forgery, and it exists *only* because of automatic attachment. A bearer token in `localStorage` is structurally immune — nothing attaches it but your own code.

The modern mitigation is `SameSite`:

| Value | Sent on cross-site requests? | Notes |
|---|---|---|
| `Strict` | Never | Safest, and breaks "click a link in an email into a logged-in page" |
| `Lax` | Only on **top-level navigations** using safe methods (a normal link click) | The default in current browsers when the attribute is omitted |
| `None` | Always — **requires `Secure`** | Necessary for genuine cross-site use; gives up the protection entirely |

`Lax`-by-default kills the classic form-POST attack, which is why CSRF feels solved today. It is not *fully* solved: it is a browser default you are depending on, subdomain takeover still bypasses it (cookies are domain-scoped), and the moment you need cross-site behaviour you set `None` and are back to needing CSRF tokens. Cookie auth done properly still means shipping either a CSRF token scheme or the double-submit pattern.

**And `Lax` does not cover WebSocket handshakes** — see §5.4. That detail is what decided this project.

---

## 3. Option B — a bearer token in Web Storage

### 3.1 Mechanics

```js
sessionStorage.setItem('hcg.token', token);                     // on sign-in (see §3.1 note)
fetch(url, { headers: { Authorization: `Bearer ${token}` } });  // on every call
sessionStorage.removeItem('hcg.token');                         // on sign-out
```

The token is an ordinary string in ordinary JavaScript storage. Nothing happens automatically. `Authorization: Bearer <token>` is the conventional header — the scheme name is from OAuth 2.0 and "bearer" is literal: whoever holds it is treated as the user, with no proof of anything else.

Storage choices, in descending order of exposure:

| Where | Survives refresh | Survives tab close | Shared between tabs | XSS-readable |
|---|---|---|---|---|
| `localStorage` | Yes | Yes | **Yes — one slot per origin** | Yes |
| `sessionStorage` | Yes | No — per-tab | No | Yes |
| A plain JS variable (in-memory) | **No** | No | No | Yes, while running |

All three are readable by any script on the origin. In-memory storage narrows the *window*, not the access — and costs you a re-login on every refresh, which is why it is only ever used with a refresh cookie behind it (§4).

The "shared between tabs" column is the one that bit us. This project originally used `localStorage` alone, which makes the session a browser-wide singleton: one slot, restored silently on every open, holding a token that stays valid for 7 days. The result was a player being signed in as somebody else with no prompt. It now runs `sessionStorage` per tab with `localStorage` as opt-in persistence — **`SESSION_PERSISTENCE.md` is the full account**, and it is required reading before touching `api.ts`'s storage functions.

### 3.2 What you get

- **No CSRF, structurally.** A cross-site page can cause a request to your server but cannot cause your header to be attached. There is no CSRF token to ship, no `SameSite` to reason about, no double-submit pattern.
- **Origin-agnostic.** Works identically whether the frontend is served from the same origin as the API or a completely different one. No `Access-Control-Allow-Credentials`, no exact-origin echo requirement, no third-party-cookie policy to outlive.
- **Explicit.** The credential is attached where you can see it in the code, which makes "why is this request unauthenticated" a five-second question.
- **Works for non-browser clients unchanged** — a CLI or a load test sets one header.

### 3.3 What you pay: XSS is strictly worse

There is no `HttpOnly` equivalent. Any script executing on your origin can read the token and send it anywhere. Compare the blast radius:

| | Cookie + `HttpOnly` | Token in `localStorage` |
|---|---|---|
| XSS can act as the user, in the page | Yes | Yes |
| XSS can **exfiltrate** the credential | No | **Yes** |
| Attack survives the user closing the tab | No | **Yes — indefinitely** |

That last row is the real cost. A stolen cookie-backed session requires the attacker to keep running code in the victim's browser; a stolen bearer token is a portable credential the attacker can use from their own machine for as long as the session lives.

Anyone who tells you "`localStorage` is fine, if you have XSS you have already lost" is wrong about the second half. Both options lose to XSS; one loses *more*.

---

## 4. Option C — the hybrid

The standard "best of both" arrangement:

- A **refresh token** in an `HttpOnly; Secure; SameSite=Strict` cookie scoped to one endpoint (`/api/auth/refresh`).
- A short-lived **access token** held only in a JavaScript variable, never persisted, attached as a bearer header.
- On page load, and every few minutes, call `/api/auth/refresh` to mint a new access token.

What it buys: the long-lived credential is XSS-unreadable, and a stolen access token expires in minutes.

What it costs, honestly:

- Two credentials, two lifetimes, two revocation stories.
- A refresh call on every page load before the app can do anything — a visible startup delay, plus every in-flight request needs queue-and-retry logic for the moment the access token expires mid-flight.
- The refresh endpoint takes a cookie, so it needs CSRF protection of its own.
- Refresh-token rotation and reuse detection if you want the theft protection to be real.

This is the right answer for a bank. It is a large amount of machinery whose entire payoff is narrowing the XSS window — and for an app whose worst-case compromise is someone playing cards as you, it is not proportionate. Noted here so the option is on the record, not because it was close.

---

## 5. WebSockets — the part that actually decides it

### 5.1 The handshake is an HTTP request

`new WebSocket('wss://example.com/socket')` does not open some new kind of connection. It sends a normal HTTP GET:

```
GET /socket HTTP/1.1
Host: example.com
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Origin: https://example.com
Cookie: session=abc123          <-- attached by the browser, automatically
```

The server replies `101 Switching Protocols`, and only then does the TCP connection stop speaking HTTP and start carrying WebSocket frames. Because that first request is a real HTTP request to `example.com`, cookies scoped to that domain are attached exactly as they would be on a `fetch`. **This is why cookie auth on WebSockets works at all**, and it is genuinely convenient.

Server-side you read them in the upgrade handler, before the socket exists:

```js
httpServer.on('upgrade', async (req, socket, head) => {
  const session = await sessionStore.get(parseCookie(req.headers.cookie || '').session);
  if (!session) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.userId = session.userId;     // the socket is born knowing who it is
    wss.emit('connection', ws, req);
  });
});
```

The appeal is real: no unauthenticated grace period, no handshake protocol of your own, and Express apps can reuse the same session middleware for HTTP routes and sockets.

### 5.2 The browser gives you almost no other options

The `WebSocket` constructor takes a URL and an optional subprotocol list. That is all. You cannot set headers:

| Thing you might want to send | Available from a browser? |
|---|---|
| `Authorization` header | **No** |
| Any custom header | **No** |
| Cookies | Yes — automatically, whether you want them or not |
| Query string | Yes |
| `Sec-WebSocket-Protocol` | Yes — second constructor argument |
| The first message after connecting | Yes |

(Node's `ws` *client* has no such limit — `new WebSocket(url, { headers: { ... } })` works fine. The restriction is a browser one.)

So cookies are the only credential that works for free, and every alternative is a workaround. That asymmetry is why cookie-on-socket is so common despite what follows.

### 5.3 Cross-site WebSocket hijacking

**The same-origin policy does not apply to WebSockets.** There is no preflight, no CORS, no `Access-Control-Allow-Origin` on a `101` response. Any page on the internet can execute:

```js
const ws = new WebSocket('wss://yourapp.com/socket');   // from evil.com
```

and the victim's browser will attach the `yourapp.com` cookie to that handshake. The socket comes up **authenticated as the victim**, and unlike CSRF the attacker can read every frame that comes back. It is CSRF with a full duplex response channel.

The only defence is checking the `Origin` header yourself in the upgrade handler. Nothing does it for you. This is not optional hardening for a cookie-authenticated socket — it is the *entire* security boundary. Miss it and every logged-in user is one visited page away from full session compromise.

### 5.4 `SameSite=Lax` does not save you here the way it saves REST

A WebSocket handshake is not a top-level navigation, so `Lax` cookies are **not** attached to a cross-site handshake in current browsers. That does blunt §5.3 — but it is a fragile thing to depend on:

- It is a browser default, not something your server states or can verify.
- It fails the moment you need `SameSite=None` for a split-origin deployment, which is exactly when your frontend and your socket are on different origins.
- Subdomain-scoped cookies are same-*site* even when they are not same-*origin*, so a compromised or attacker-controlled subdomain is inside the fence.

So the cross-site risk is either "mitigated by a default I am not in control of" or "wide open", depending on a deployment decision made elsewhere. That is an uncomfortable place for the primary session credential to sit.

### 5.5 A handshake happens once; a socket lives for hours

Cookie auth authenticates at second zero and never again. A game socket may stay open for an entire evening. In between:

- The session expires → the socket keeps working.
- The user hits "sign out everywhere" → the socket keeps working.
- The password is changed to lock an intruder out → **the intruder's socket keeps working.**

Nothing about a cookie reaches an already-open connection. Any cookie-authenticated socket system therefore needs a revalidation tick or a hard maximum connection lifetime bolted on, or its revocation story is a lie. This is not an argument for bearer tokens specifically — the same trap applies to a token sent once in a first message, and §8 records it as a live gap here — but it *is* an argument against assuming the cookie handled it.

### 5.6 The five ways people actually authenticate a socket

| Approach | How | Pros | Cons |
|---|---|---|---|
| **Cookie at the handshake** | Browser attaches it; read `req.headers.cookie` on upgrade | Free; socket authenticated before it exists; `HttpOnly` | CSWSH unless you check `Origin`; `SameSite` fights split-origin; no revocation after connect |
| **Ticket** | Authenticated `POST /ws-ticket` returns a short-lived single-use token; connect to `?ticket=...` | Ticket is worthless after ~30s and one use; keeps the real session out of the URL | An extra round trip; tickets land in access and proxy logs; a second credential type to implement |
| **Subprotocol smuggling** | `new WebSocket(url, ['auth', token])` — the one header a browser lets you set | No extra round trip; not in the URL | Abuse of the field; the server *must* echo a valid subprotocol or the browser aborts; confusing to anyone reading it later |
| **Query parameter** | `wss://host/socket?token=...` | Trivial | The long-lived session token ends up in server logs, proxy logs, and referrer chains. Avoid |
| **First message** | Connect anonymously, send `{ type: 'AUTHENTICATE', token }` immediately, refuse everything else until it arrives | Works with any storage; no URL exposure; no extra round trip; the auth step is explicit and testable | A brief unauthenticated socket exists and consumes resources — needs a timeout; the protocol has a state machine the client must respect |

---

## 6. What this project does, and why

### 6.1 The mechanism, end to end

```
sign-in    POST /api/auth/login  ->  { token, user, expiresAt }
storage    sessionStorage['hcg.token'] per tab,         frontend/src/api.ts (storage section)
           localStorage['hcg.token'] only if the
           player ticked "Keep me signed in"            SESSION_PERSISTENCE.md
REST       Authorization: Bearer <token>                frontend/src/api.ts (post/fetch helpers)
           requireBearer(req)                           backend/src/http/auth-routes.ts:187
socket     gate 1: Origin allowlist at the upgrade      backend/src/ws/origin.ts
           gate 2: { type: 'AUTHENTICATE', token }      backend/src/ws/ws-server.ts:370
```

Option B, with the **first-message** row of §5.6 for the socket. No `Set-Cookie` is issued anywhere in the codebase, and the CORS block (`auth-routes.ts:175-177`) deliberately never sets `Access-Control-Allow-Credentials` — there are no credentials for the browser to attach.

### 6.2 The four reasons, in order of weight

**1. The WebSocket is the primary channel, and cookies are worst exactly there.** This is not a REST app with a socket bolted on; the game *is* the socket. §5.3 and §5.4 describe the failure mode, and §5.5 describes a revocation gap that would sit directly on top of a feature this project ships — `change-password` revokes every other session (`AUTH.md` §6), and that promise has to hold for open sockets too, not just future requests. With the token in `localStorage`, an attacker's page cannot read it and cannot make the browser send it, so a cross-site socket has nothing to authenticate with even if the origin check were somehow bypassed. That is a real second layer rather than a restatement of the first.

**2. Browsers cannot set headers on a socket anyway.** Even having chosen cookies for REST, the socket would still need *some* mechanism from §5.6. Having picked first-message auth there, using the same token over an `Authorization` header for REST means one credential and one storage location rather than two of each.

**3. Split-origin deployment is supported.** `DEPLOYMENT.md` covers running the frontend and backend on different origins. Cookies across origins need `SameSite=None; Secure`, `Access-Control-Allow-Credentials: true`, an exact-origin CORS echo (no `*`), HTTPS on both ends, and survival of tightening third-party-cookie policies — a stack of settings that fails silently and in ways that look like application bugs. A bearer header is identical in both topologies.

**4. CSRF disappears entirely.** No CSRF tokens, no double-submit, no `SameSite` reasoning, and no class of bug where a new endpoint is added without protection. This is a real reduction in the amount of security machinery in the codebase, which matters more than it sounds: the machinery you do not have cannot be misconfigured.

### 6.3 What it costs, stated plainly

**XSS is correspondingly more serious**, exactly as §3.3 describes, and this is written down in `AUTH.md` §5, `DEPLOYMENT.md` §7, and `origin.ts`'s header comment so nobody rediscovers it by accident. There is no `HttpOnly` here. A script running on our origin can read `hcg.token` and walk off with the session.

What blunts it:

- **The token is opaque and revocable.** It is 32 random bytes naming a row — not a JWT, so it carries no claims and cannot be re-signed or extended. Deleting the row ends it immediately, everywhere. `logout-all` exists and is one call.
- **Sliding 7-day expiry**, so a stolen token is not indefinite.
- **The blast radius is bounded by what the app does.** Worst case is someone playing cards as you and reading your display name and email. There is no money, no payment data, and no data export.
- **Password change revokes every other session**, which is the recovery path if it happens.

The honest summary: the mitigation for the XSS risk is not letting XSS happen, and that is a separate discipline (no `dangerouslySetInnerHTML` on user content, no `eval`, a tight CSP if this ever faces real stakes). Choosing cookies would not have removed that obligation — it would only have changed what an XSS gets you from "the token" to "requests while the page is open".

### 6.4 The compensating controls, and why each exists

Since the token is not `HttpOnly`, the surrounding defences carry more weight:

| Control | Where | What it covers |
|---|---|---|
| Origin allowlist at the upgrade | `ws/origin.ts` | Rejects cross-site sockets before any state is allocated — kept even though `localStorage` already makes CSWSH unexploitable, because an unauthenticated socket still costs a slot, a heartbeat timer and a rate-limit bucket |
| 10s `AUTHENTICATE` timeout | `ws-server.ts` (`authTimeoutMs`, default `10_000`) | Closes the §5.6 first-message gap — the window where an unauthenticated socket squats on resources |
| `AUTH_FAILED` (4001) as a terminal close code | `ws-server.ts` | A bad token stops the client retrying forever instead of hammering the server with a credential that will never work |
| Connection cap per account, cluster-wide | `ConnectionRegistry` | Bounds what a stolen token can do to the server even before anyone notices |
| Per-IP rate limits, shared across the cluster | `core/ratelimit/` | The bearer token has no CSRF story to lean on, so brute-force pressure lands here |

Note the deliberate redundancy on the first row: the origin check does not *depend* on the storage choice, and the storage choice does not *depend* on the origin check. Either alone stops cross-site socket hijacking; both are cheap.

### 6.5 What would change the answer

Revisit this if any of these become true:

- **The app starts handling something worth stealing** — payments, real identity, anything with a regulator. `HttpOnly` stops being a nice-to-have and the §4 hybrid becomes proportionate.
- **The socket stops being the primary channel.** If most traffic became ordinary REST on a single origin, reason 1 evaporates and cookies get much more attractive.
- **Third-party rich content gets embedded in the page**, raising XSS likelihood from "a bug we can avoid" to "a dependency we do not control".
- **Someone wants sign-in shared across subdomains.** Cookies do that natively via `Domain`; `localStorage` is origin-scoped and cannot.

None of these are true today.

---

## 7. Summary table

| | Cookie | Bearer in `localStorage` (**this project**) | Hybrid |
|---|---|---|---|
| Survives refresh | Free | One line of code | Refresh call on load |
| REST attachment | Automatic | Manual header | Manual header |
| WebSocket attachment | Automatic — and hazardous | First message | First message |
| CSRF | Real; needs `SameSite` + tokens | **None, structurally** | On the refresh endpoint |
| XSS steals the credential | No (`HttpOnly`) | **Yes** | Short-lived only |
| Cross-site / split-origin | Painful (`SameSite=None`, `Allow-Credentials`) | **Identical either way** | Painful |
| Revocation after connect | Nothing reaches an open socket | Nothing reaches an open socket | Access token expires |
| Moving parts | Cookie attributes + CSRF scheme | One header, one storage key | Two credentials, two lifetimes, rotation |

---

## 8. Mistakes worth not repeating

- **Assuming CORS protects a WebSocket.** It does not exist there. If you ever add a second socket endpoint, it needs the `Origin` check too — `isOriginAllowed` is called once, in `handleUpgrade`, and a new upgrade path would bypass it.
- **Putting a session token in the URL.** `?token=...` is in every access log and proxy log on the path. If a socket credential ever needs to be in the URL, it must be a single-use ticket with a 30-second life, not the session token.
- **Adding a cookie "just for one thing."** The moment any `Set-Cookie` exists on this origin, every cookie-shaped problem in §2.3 comes back — the browser will attach it to WebSocket handshakes too, and `origin.ts`'s comment about not depending on the token staying out of cookies stops being true.
- **Trusting a socket's identity after the handshake without re-checking it.** §5.5 applies to us as much as to cookie systems: `AUTHENTICATE` happens once, and nothing re-validates the session on a socket that stays open. A connection outliving a `logout-all` or a password change is a real gap, currently bounded only by the per-account connection cap and the heartbeat cycle. Not fixed, knowingly — recorded here so it is a decision rather than an oversight.
