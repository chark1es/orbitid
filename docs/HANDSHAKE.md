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

No active session (or an expired, idle, ended, revoked or pending-MFA one): the API answers
`302 -> redirect_url?__orbit_handshake=signed_out`. The middleware then clears `__session`, sets
`__client_uat=0` and continues as signed out, so the visitor sees the normal signed-out experience
instead of an error.

## Endpoint

`GET /v1/client/handshake?redirect_url=<absolute url>`

| Situation | Answer |
|---|---|
| Active session for the `__client` cookie | `302` to `redirect_url` with `__orbit_handshake=<jwt>` |
| No client cookie, no session, expired / idle / ended / revoked session, `pending` (MFA enrolment) session | `302` to `redirect_url` with `__orbit_handshake=signed_out` |
| Missing `redirect_url`, malformed URL, `javascript:`/`data:`/other scheme, other origin, credentials in the URL | `400` with the standard error body |
| Too many requests from one address (120 per minute) | `429` |

Every response carries `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.

`redirect_url` is validated by the same `validateRedirectUrl` used for post-sign-in navigation: a
relative path, the instance's `application.homeUrl`, or an origin in `application.allowedOrigins` /
`application.allowedRedirectOrigins` (plus `localhost` in development mode). The API's own origin is
also accepted. Credentials (`user:pass@`) are rejected. `//evil.example`, `/\evil.example`,
`javascript:` and `data:` cannot pass because the value is resolved against the instance URL first and
the resulting origin is what gets checked.

The minted token is a normal session token: same signing key, same lifetime, `azp` set to the app
origin from `redirect_url`, and the instance's custom session claims and JWT templates apply exactly
as on `POST /v1/client/sessions/:id/tokens`. The handshake always uses the default (non-template)
token, because that is the one `__session` holds.

## Cookies involved

| Cookie | Set by | Host | Purpose |
|---|---|---|---|
| `__client` | API | API | Opaque client token, `httpOnly`, 1 year. This is what the handshake reads. |
| `__session` | browser SDK, or the middleware after a handshake | app | Session JWT, session cookie, `Path=/; SameSite=Lax; Secure` on https. |
| `__client_uat` | browser SDK, or the middleware after a handshake | app | Unix seconds of the client's last activity, `0` when signed out, 1 year. Tells the middleware whether a live client exists without calling the API. |
| `__orbit_handshake_pending` | middleware | app | `1`, `httpOnly`, 30 s. Marks that one handshake attempt is in flight (loop guard). |

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
  same `verifySessionToken` path as `__session` (JWKS, issuer, expiry, `azp`). A tampered, expired or
  foreign token is ignored, cookies are cleared and the visitor continues signed out.
- **One attempt per navigation.** The middleware sets `__orbit_handshake_pending` before redirecting
  and checks it before redirecting again; a browser that comes back still without a usable token
  continues signed out. That, plus `signed_out` clearing `__client_uat`, means no redirect loop.
- **Only a handshake the middleware started is completed.** Without the marker cookie, a
  `?__orbit_handshake=…` parameter is stripped and ignored, so a crafted link carrying someone else's
  token cannot sign a browser in or out.
- **Cookie tossing is out of scope.** Like every cookie-based session, an attacker who can set cookies
  for your domain (for example from a sibling subdomain) can force a handshake. Scope `__session` and
  `__client_uat` to a domain you control exclusively, and keep the API's `allowedOrigins` minimal.
- **Only top-level navigations.** The handshake runs only for `GET` with `Sec-Fetch-Mode: navigate`
  (or, when that header is missing, `Accept: text/html`), never for `fetch`/XHR, RSC payloads,
  prefetches or non-GET requests. API routes keep returning their own status codes.
- **Rate limited.** `hit()` per client address, 120 per minute, on top of the normal per-session token
  mint limits.

## What changes for apps

- **Nothing to configure in Next.js.** `orbitIdMiddleware` performs the handshake by default. Turn it
  off with `orbitIdMiddleware(handler, { handshake: { enabled: false } })`, set a cookie domain with
  `{ handshake: { cookieDomain: ".example.com" } }` when the SDK writes `__session` on a parent
  domain, or force `Secure` with `{ handshake: { secure: true } }` behind a TLS-terminating proxy that
  hides the scheme.
- **The API must know your app origin.** A hard navigation only succeeds if the app's origin is in
  `allowedOrigins`/`allowedRedirectOrigins` (or is `homeUrl`) in the instance settings; otherwise the
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
