# Server-side handshake

A hard navigation (a full page load, a link from another site, a form submit, a refresh after a long
idle period) arrives at your app with whatever the browser stored. The session JWT in `__session`
lives for `session.tokenLifetimeSeconds` (60 s by default) and is refreshed by the browser SDK while
a tab is open. A hard navigation after the tab was closed, or after 60 s with no SDK refresh, carries
an expired — or missing — `__session` even though the visitor still has a valid client cookie
(`__client`, httpOnly, on the API host) and a live session on the server.

Before the handshake, that request read as signed out: `@orbitid/nextjs` middleware bounced the
visitor to the sign-in page, and `authenticateRequest` in `@orbitid/backend` returned a signed-out
result. The handshake fixes that by letting the server mint a fresh session token for the live client
and hand it back to the app in a redirect.

## Flow

```
Browser                      App (Next.js)                OrbitID API
   |                              |                             |
   | GET /dashboard (navigate)    |                             |
   |  __client_uat=1700…          |                             |
   |  __session=<expired>         |                             |
   |----------------------------->|                             |
   |                              | middleware: no valid token, |
   |                              | but __client_uat > 0        |
   |                              |                             |
   | 307 -> https://api…/v1/client/handshake?redirect_url=…     |
   |<-----------------------------|                             |
   |  Set-Cookie: __orbit_handshake_pending=1 (30 s, httpOnly)  |
   |                                                            |
   | GET /v1/client/handshake?redirect_url=https://app/dashboard
   |  Cookie: __client=<client token>                           |
   |----------------------------------------------------------->|
   |                         finds the client's active session  |
   |                         mints a session JWT (60 s)         |
   |                                                            |
   | 302 -> https://app/dashboard?__orbit_handshake=<jwt>       |
   |  Cache-Control: no-store, Referrer-Policy: no-referrer     |
   |<-----------------------------------------------------------|
   |                              |                             |
   | GET /dashboard?__orbit_handshake=<jwt>                     |
   |------------------------------>|                            |
   |                              | verify with JWKS exactly   |
   |                              | like a session token       |
   | 307 -> /dashboard            |                            |
   |  Set-Cookie: __session=<jwt> |                            |
   |  Set-Cookie: __client_uat=<now>                            |
   |<-----------------------------|                             |
   | GET /dashboard (clean URL, fresh cookies)                  |
   |----------------------------->|  signed in                 |
```

No live session (an expired, idle, ended or revoked one): the API answers
`302 -> redirect_url?__orbit_handshake=signed_out`. That answer is authoritative, so the middleware
clears `__session`, sets `__client_uat=0` and continues as signed out, so the visitor sees the normal
signed-out experience instead of an error.

A **pending session** (required MFA not yet enrolled) is live, not signed out. The API mints the same
`sts: "pending"` token the token endpoint returns; the middleware writes the cookies and reports
signed-in-incomplete. Apps can then route the user to enrolment. It is never cleared as a sign-out and never
treated as fully authenticated.

If the returned token cannot be verified — a few seconds of clock skew, a key rotation the process has
not fetched yet, a truncated URL — the middleware keeps `__client` and `__client_uat` and answers the same
retriable **503** as an infrastructure failure: `Retry-After`, a small meta-refresh page (or JSON for a
fetch), and the handshake marker set to `retry`. The next clean navigation therefore retries the handshake
instead of reaching `protect()` as signed-out and redirecting to sign-in. A
`__orbit_handshake_unavailable` counter bounds this: after three consecutive unavailable answers the
middleware stops the automatic retries and serves a **terminal 503** with a manual "Try again" link. That
page never redirects to sign-in and never meta-refreshes; the credentials stay untouched, and the link
clears the counter so the visitor can start a fresh bounded set of attempts. `Retry-After` is capped at
60 s, and the marker/counter cookies live `max(300 s, 3 × Retry-After)`, so a long delay can never outlive
the counter and reset the bound. A verification failure is still not proof that the session ended; only
the API's `signed_out` answer is.

An **infrastructure failure** while minting (an unreadable signing key, a database error) is not a sign-out
either. The API answers `302 -> redirect_url?__orbit_handshake=transient` with `Retry-After: 5`. The
middleware treats this as an explicit **unavailable** state: cookies stay, the marker becomes `retry`, and the
request answers **503** with `Retry-After: 3` — a document gets a tiny meta-refresh page that retries the
handshake, a fetch gets JSON. It never calls the unauthenticated redirect, so a database outage cannot turn a
signed-in visitor into a sign-in redirect. Only a positive re-read showing that the session (or user) is
ended/banned produces `signed_out`. A failed activity write is logged and never fails the handshake.

## Endpoint

`GET /v1/client/handshake?redirect_url=<absolute url>`

| Situation | Answer |
|---|---|
| Active session for the `__client` cookie | `302` to `redirect_url` with `__orbit_handshake=<jwt>` |
| Pending session (required MFA not enrolled) | `302` to `redirect_url` with a `sts: "pending"` token; cookies stay, the visitor is signed-in-incomplete |
| No client cookie, no session, expired / idle / ended / revoked session | `302` to `redirect_url` with `__orbit_handshake=signed_out` |
| Missing `redirect_url`, malformed URL, `javascript:`/`data:`/other scheme, other origin, credentials in the URL | `400` with the standard error body |
| Signing-key or database failure while minting | `302` to `redirect_url` with `__orbit_handshake=transient` and `Retry-After: 5` |
| Too many requests from one address (600 per minute) | `429` |

Every response carries `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.

`redirect_url` receives a session token, so it must be an *application* origin: a relative path (resolved against
`application.homeUrl`), the instance's `application.homeUrl`, or an origin in `application.allowedOrigins` (plus
`localhost` in development mode). The API's own origin is also accepted. An origin that is only in
`application.allowedRedirectOrigins` is refused, because that list means "users may be sent there", not "this site
may act as the user". Credentials (`user:pass@`) are rejected. `//evil.example`, `/\evil.example`,
`javascript:` and `data:` cannot pass because the value is resolved against the instance URL first and
the resulting origin is what gets checked.

The minted token is a normal session token: same signing key, same lifetime, `azp` set to the app
origin from `redirect_url`, and the instance's custom session claims and JWT templates apply exactly
as on `POST /v1/client/sessions/:id/tokens`. The handshake always uses the default (non-template)
token, because that is the one `__session` holds.

## Cookies involved

| Cookie | Set by | Host | Purpose |
|---|---|---|---|
| `__client` | API | API | Opaque client token, `httpOnly`, `SameSite=Lax`, `Path=/`, 400 days (the browser maximum). This is what the handshake reads. |
| `__session` | browser SDK, or the middleware after a handshake | app | Session JWT, `Path=/; SameSite=Lax; Secure` on https, 400 days as a cookie. The JWT inside still expires in ~60 s and is replaced on every refresh. |
| `__client_uat` | browser SDK, or the middleware after a handshake | app | Unix seconds of the client's last activity, `0` when signed out, 400 days. Tells the middleware whether a live client exists without calling the API. |
| `__orbit_handshake_pending` | middleware | app | `1` or `retry`, `httpOnly`, 30 s (the `retry` marker uses `max(300 s, 3 × Retry-After)`). Marks that one handshake attempt is in flight (loop guard), or that the last answer was unavailable and should be retried. |
| `__orbit_handshake_unavailable` | middleware | app | Count of consecutive unavailable handshake answers, `httpOnly`, `max(300 s, 3 × Retry-After)`. Capped at 3; after that the visitor gets a terminal 503 with a manual retry link. |

The handshake needs `__client` and the app origin on the same site, which is the normal setup: the
browser sends `__client` to the API host on top-level navigations (`SameSite=Lax`). If your app lives
on a different site than the API and you use a proxy (`proxyUrl` in the browser SDK), the cookie is
sent to the proxied origin instead.

## Security notes

- **The token travels in a URL.** It is short lived (60 s, or `session.tokenLifetimeSeconds`), single
  use in practice (the middleware immediately moves it into a cookie), and the redirect response is
  `no-store` with `no-referrer`, so the token does not reach the app's server logs, the history entry
  or a third-party referrer. The middleware strips the parameter with a redirect to the clean URL
  before any app code runs. Access logs on the *API* host will contain the token in the request line
  of the app's follow-up request — configure API access logs accordingly, or keep the token lifetime
  low (it already is).
- **Only allow-listed origins get a token.** A handshake for `https://evil.example` is a 400, so the
  endpoint cannot be used to hand a token to an attacker's origin. `azp` on the token matches the
  target origin and the middleware's `authorizedParties` check applies to it as usual.
- **The token is verified, never trusted.** The middleware verifies `__orbit_handshake` through the
  same `verifySessionToken` path as `__session` (JWKS, issuer, expiry, `azp`) with a 60 s clock
  tolerance. A token that does not verify is ignored and never signs anybody in; the visitor's cookies
  are left intact so the next navigation can try again.
- **One attempt per navigation.** The middleware sets `__orbit_handshake_pending` before redirecting
  and checks it before redirecting again; a browser that comes back still without a usable token
  continues signed out. A failed verification or a `transient` answer sets the marker to `retry` and
  serves a 503 that waits before retrying the handshake; the credentials are never cleared on that
  path. `__orbit_handshake_unavailable` counts consecutive unavailable answers and, after three, serves
  a terminal 503 with a same-origin "Try again" link. The link clears the counter and marker, so the
  visitor can retry manually with a fresh, still-bounded budget; there is no automatic loop.
- **Only a handshake the middleware started is completed.** Without the marker cookie, a
  `?__orbit_handshake=…` parameter is stripped and ignored, so a crafted link carrying someone else's
  token cannot sign a browser in or out.
- **Cookie tossing is out of scope.** Like every cookie-based session, an attacker who can set cookies
  for your domain (for example from a sibling subdomain) can force a handshake. Scope `__session` and
  `__client_uat` to a domain you control exclusively, and keep the API's `allowedOrigins` minimal.
- **Only top-level navigations.** The handshake runs only for `GET` with `Sec-Fetch-Mode: navigate`
  (or, when that header is missing, `Accept: text/html`), never for `fetch`/XHR, RSC payloads,
  prefetches or non-GET requests. API routes keep returning their own status codes.
- **Rate limited, generously.** `hit()` per client address, 600 per minute, on top of the normal
  per-session token mint limits. A restored browser can replay the handshake once per tab and an office
  may share one address, so a refresh must not look like abuse.

## What changes for apps

- **Nothing to configure in Next.js.** `orbitIdMiddleware` performs the handshake by default. Turn it
  off with `orbitIdMiddleware(handler, { handshake: { enabled: false } })`, set a cookie domain with
  `{ handshake: { cookieDomain: ".example.com" } }` when the SDK writes `__session` on a parent
  domain, or force `Secure` with `{ handshake: { secure: true } }` behind a TLS-terminating proxy that
  hides the scheme.
- **The API must know your app origin.** A hard navigation only succeeds if the app's origin is in
  `allowedOrigins` (or is `homeUrl`) in the instance settings; otherwise the
  API answers the handshake with a 400 instead of redirecting. Development mode accepts `localhost`.
- **Server helpers see a signed-in user.** `auth()` no longer observes `handshake` state on a hard
  navigation because the navigation never reaches the app with a dead token: it is redirected through
  the handshake first. The forwarded `handshake` state still exists for non-navigation requests and
  when the handshake is disabled, and `<HandshakeRefresher/>` still refreshes those.
- **Other frameworks (Node SDK).** `authenticateRequest(request, { apiUrl | publishableKey,
  returnBackUrl })` returns `handshakeUrl` next to the existing `status`/`reason` fields whenever a
  handshake could help: a live `__client_uat` with a missing, expired or invalid `__session`, for
  cookie-authenticated requests. Redirect the browser there. It is `null` for signed-in requests, for
  signed-out visitors without a live client, for Bearer-token callers (they can mint their own token)
  and when the endpoint cannot be derived from `apiUrl`/`publishableKey`.
- **The browser SDK is unchanged from the app's point of view.** It still writes `__session` and
  `__client_uat` after sign-in and on every token refresh; `__client_uat` is now written even when the
  token request fails, so a handshake can still recover the session on the next hard navigation.

## Known gap

The token in the redirect URL is a real session token and lives as long as any other session token. A
user who copies the URL within that window can present it as a Bearer token; this is the same exposure
as copying the `Authorization` header, bounded by the 60 s lifetime. The redirect is `no-store` and
`no-referrer`, the parameter is stripped before the app renders, and the marker cookie bounds retries.
