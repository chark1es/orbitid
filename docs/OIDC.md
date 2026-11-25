# OIDC and OAuth 2.0 provider

OrbitID can act as the identity provider for your own applications. Users sign in on OrbitID (password, social,
enterprise SSO, second factor…) and your application receives standard OIDC tokens. No extra process or service
is needed: the provider is part of the server and lives under `/oauth` and `/.well-known`.

Everything below is standard OIDC/OAuth 2.0, so any conforming client library works.

## Stable contract

These values are part of the compatibility promise. A client that works today keeps working across OrbitID
releases:

| Item | Value |
|---|---|
| Issuer (`iss`, discovery `issuer`) | The instance's public base URL, exactly, without a trailing slash |
| Discovery | `/.well-known/openid-configuration` and `/.well-known/oauth-authorization-server`, plus the path-based variants below |
| Response type | `code` only |
| Grant types | `authorization_code`, `refresh_token`, and `urn:ietf:params:oauth:grant-type:device_code` when the device grant is enabled |
| Signing | RS256 with a `kid`; every published key has `use: "sig"` and `alg: "RS256"` |
| `sub` | The stable, opaque OrbitID user id (`user_…`); it never changes for an account |
| Token endpoint auth | `client_secret_basic`, `client_secret_post`, and `none` for public clients with PKCE |
| PKCE | `S256`; optional for confidential clients, mandatory for public clients and apps with "Require PKCE" |
| Access tokens | Opaque by default; RS256 JWT when `oidcProvider.accessTokenFormat` is `jwt` |
| Refresh tokens | Rotating, single-family, with a short retry grace window (see below) |
| Errors | OAuth `{ "error", "error_description" }` bodies with standard HTTP status codes |

**The issuer must match exactly.** Configure clients with the same base URL printed on the dashboard's
**OAuth applications** page (and in discovery). A trailing slash, `http` vs `https`, a different host, or a
path prefix changes the issuer and makes clients reject the ID token. The dashboard reads the issuer from
discovery, not from its own development origin.

### Issuer behind a reverse proxy

Set `ORBITID_BASE_URL` to the public URL (for example `https://auth.example.com`). It is authoritative:
OrbitID uses it for discovery, every `iss` claim and every advertised endpoint, whatever host or scheme the
request arrived on.

If `ORBITID_BASE_URL` is **not** set and `ORBITID_TRUST_PROXY` is at least `1`, OrbitID derives the public
origin from `X-Forwarded-Proto`, `X-Forwarded-Host` and `X-Forwarded-Port`. The proxy must set those headers on
every request, including token and userinfo calls, or the issuer can differ between requests. A forwarded
`Host` that contains a path, credentials or anything other than a hostname is ignored, and the configured URL
is used instead. Prefer `ORBITID_BASE_URL` for production: it is stable even when a health check or an
internal call reaches the server directly.

Path-based issuers work too. An issuer of `https://example.com/orbitid` is served at
`https://example.com/orbitid/.well-known/openid-configuration` and
`https://example.com/orbitid/.well-known/oauth-authorization-server`; both return the same document. When the
issuer has a path, configure the proxy to strip that prefix before forwarding `/oauth/*` requests (or set
`ORBITID_BASE_URL` to the origin and keep the prefix out of the issuer).

## Register an application

Applications are managed with the Backend API (secret key):

```bash
curl -X POST http://localhost:4000/v1/oauth_applications \
  -H "Authorization: Bearer sk_test_..." \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Grafana",
    "redirect_uris": ["https://grafana.example.com/login/generic_oauth"],
    "post_logout_redirect_uris": ["https://grafana.example.com/login"],
    "scopes": "openid profile email groups offline_access",
    "public": false,
    "consent_screen_enabled": false,
    "pkce_required": false,
    "groups_claim": "all",
    "access_token_lifetime_seconds": 3600,
    "refresh_token_lifetime_seconds": 2592000,
    "id_token_lifetime_seconds": 3600
  }'
```

The response contains `client_id` and, for a confidential client, `client_secret`. The secret is shown **once**;
store it like a password. `POST /v1/oauth_applications/:id/rotate_secret` issues a new one and invalidates the old
secret immediately. The dashboard shows the same response and keeps the secret write-only.

| Field | Meaning |
|---|---|
| `redirect_uris` | Exact match only. A request for any other URI is rejected before the user sees anything. Loopback (`http://localhost`, `http://127.0.0.1`, `http://[::1]`) accepts any port for native apps, as RFC 8252 §7.3 requires, but the scheme, host and path must still match. |
| `post_logout_redirect_uris` | Exact match for RP-initiated logout. An unregistered value is refused, not redirected. |
| `scopes` | The **allowlist** this application may request (space separated). `openid` is always allowed; every other scope — including the standard `profile`, `email`, `phone`, `groups`, `organizations` and `offline_access` — must be listed here or it is refused with `invalid_scope`. New applications default to `openid profile email`; add `groups`/`organizations`/`offline_access` only when the integration needs them. |
| `public` | A browser/mobile client without a secret. PKCE is then mandatory. |
| `pkce_required` | Requires PKCE (S256) for a confidential client. **Off by default** so Tinyauth, Authentik sources, oauth2-proxy and similar clients that send no challenge work unchanged. |
| `consent_screen_enabled` | Shows the consent screen the first time a user authorizes the app. Turn it off for first-party/trusted apps to skip consent entirely. |
| `groups_claim` | `none`, `organizations` (org slugs), `roles` (org and instance role keys) or `all` (the union). New applications default to `none` (no claim); applications created before this release keep `all`, and the upgrade migration records the base scopes they already used. |
| `*_token_lifetime_seconds` | Per-application lifetimes. Access/ID: 60–86400; refresh: 60–31536000. Access tokens default to **300 s** (5 minutes) for new applications; set a longer value explicitly. |

Only `code_challenge_method=S256` is accepted; `plain` is refused, and a request with no challenge is refused for
public clients and for clients with `pkce_required`.

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /.well-known/openid-configuration` | OIDC discovery document |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 authorization-server metadata (same values) |
| `GET <issuer-path>/.well-known/…` | Path-based discovery for issuers with a path prefix |
| `GET /oauth/jwks` | Public signing keys (RS256, `kid`, `use: sig`) |
| `GET /oauth/authorize` | Authorization code flow (login + consent); `response_mode=query` or `form_post` |
| `POST /oauth/token` | `authorization_code`, `refresh_token`, and `urn:ietf:params:oauth:grant-type:device_code` |
| `GET`/`POST /oauth/userinfo` | Claims for an access token (Bearer header, `access_token` form field, or `?access_token=`) |
| `POST /oauth/introspect` | RFC 7662 token introspection (confidential clients) |
| `POST /oauth/revoke` | RFC 7009 token revocation |
| `GET`/`POST /oauth/end_session` | RP-initiated logout (`id_token_hint`, `post_logout_redirect_uri`, `state`) |
| `POST /oauth/device_authorization` | RFC 8628 device flow (when enabled) |
| `GET /oauth/device` | Device verification page (the `verification_uri`) |

Client authentication is `client_secret_basic` or `client_secret_post` (or `none` for public clients). Basic
credentials are accepted both form-urlencoded (RFC 6749 §2.3.1) and raw, because real clients do both.

Discovery, JWKS, token, userinfo, revocation, introspection and end-session answer CORS preflights and send
`Access-Control-Allow-Origin: *`: they are bearer-token endpoints and never rely on a cookie, so browser SPAs can
call them directly.

The authorization code is single-use, lives 10 minutes, and is bound to the `redirect_uri` and PKCE verifier of the
request. Presenting it twice — or with the wrong redirect URI or verifier — returns `invalid_grant`. `redirect_uri`
may be omitted at the token endpoint when the code is unambiguous; if it is sent it must match the authorization
request exactly.

Presenting an **already consumed** code also revokes every access and refresh token the first exchange issued from
it, as RFC 6749 §4.1.2 and OIDC Core §3.1.3.2 recommend: a code offered twice may have leaked. The code row records
the token family the exchange created, and the revocation uses the same family lock as refresh-token reuse, so it
is atomic and works across replicas. Consuming a code and inserting its token set are one transaction, which means
a concurrent duplicate cannot revoke the winner's tokens before they exist; exactly one exchange succeeds, and the
loser's replay revokes the family. A first exchange with no replay is unaffected.

Refresh tokens rotate on every use and are bound to a *token family*. Rotation persists the consumption time and
the successor token id on the token that was consumed. Consuming the presented token, checking that the family is
still live and inserting the successor + access token happen in **one transaction**, serialized against family
revocation. A concurrent duplicate therefore waits (or retries) and sees the committed successor; it cannot
observe a consumed token with no successor and revoke a live family, and a successor cannot be inserted into a
family that was revoked concurrently. Reusing a rotated-out token **within the grace window**
(`oidcProvider.refreshTokenReuseGraceSeconds`, default 30 seconds, measured from that original consumption) is
treated as a retry of a lost response or a concurrent refresh: it returns the **same successor** refresh token
and mints a fresh access token, without rotating again. Replaying the same old token cannot keep extending the
window. Reuse **outside** the window is treated as theft and revokes the whole family, including its access
tokens. Concurrent refreshes never destroy a grant on their own.

An access or refresh token is only usable while the browser session that authorized it is still active. Signing
out, an operator revoke, a ban, sign-out-all, session removal or expiry revokes every code/access/refresh token
minted from that session, and `/oauth/userinfo`, `/oauth/introspect` and the refresh grant check the session
again. The device authorization grant has no browser session, so its tokens keep their own lifecycle.

`scope` on a refresh must be a subset of the original grant. Asking for a scope that was never granted returns
`invalid_scope`; omitting it keeps the original scope.

## JWT or opaque access tokens

By default access tokens are opaque strings (`oat_…`) and every resource server must call `/oauth/userinfo` (or
`/oauth/introspect`) to check them. Set

```jsonc
// PATCH /v1/instance
{ "oidcProvider": { "accessTokenFormat": "jwt" } }
```

and access tokens become RS256 JWTs signed with the instance signing key — the same key as session tokens, so
`/oauth/jwks` verifies them. Claims:

| Claim | Meaning |
|---|---|
| `iss` | Instance URL |
| `sub` | User id |
| `aud`, `azp` | The application's `client_id` |
| `scope` | Granted scopes, space separated |
| `iat`, `exp` | Issued at / expiry (the application's access-token lifetime, 5 minutes by default) |
| `jti` | Grant id |
| `sid` | The OrbitID session the grant came from, when there was one |
| `groups` | Only with the `groups` scope (see above) |
| `org_*`, `organizations` | Only with the `organizations` scope (see below) |

Resource servers can verify these offline with the JWKS. JWT access tokens are still recorded in the grant table,
so revocation keeps working: after `POST /oauth/revoke`, `/oauth/userinfo` and `/oauth/introspect` both reject the
token, even though its signature is still valid. Revocation wins.

Opaque and JWT tokens are both accepted by `/oauth/userinfo`, so switching formats does not break clients that
already hold a token.

## Scopes and claims

The application's `scopes` field is enforced as an allowlist (see above). Requesting a scope the app did not
configure returns `invalid_scope`; `openid` is always allowed. This matters most with the consent screen off,
where nothing else would tell the user what is disclosed.

| Scope | Claims it unlocks |
|---|---|
| `openid` | `sub`, `iss`, `aud`, `exp`, `iat`, `auth_time`, `nonce`, `at_hash`, `azp`, `sid`, and the `id_token` |
| `profile` | `name`, `given_name`, `family_name`, `preferred_username`, `picture`, `locale`, `updated_at` |
| `email` | `email`, `email_verified` |
| `phone` | `phone_number`, `phone_number_verified` |
| `groups` | `groups` (see below) |
| `organizations` | `org_id`, `org_slug`, `org_role`, `org_permissions`, `organizations` |
| `offline_access` | A refresh token |

`preferred_username` falls back from the OrbitID username to the local part of the primary email and finally to
the user id, so a username-less account still has a usable value. `sub` is always the stable user id; do not use
`preferred_username` as a primary key. `updated_at` is seconds since the epoch.

`auth_time` is the first-factor time of the OrbitID session that authorized the grant. `sid` is that session's
id. Both are absent for the device grant, which has no browser session.

### Groups

The `groups` claim exists for role mapping. Its values are stable identifiers, not display names:

```json
{ "groups": ["acme", "org:admin", "app:reviewer"] }
```

- Organization slugs (`acme`).
- Organization role keys (`org:admin`, `org:member`, or a custom key).
- Instance role keys (`app:reviewer`).

The application's `groups_claim` setting chooses the subset: `none`, `organizations` (slugs only), `roles`
(role keys only) or `all` (the union). New applications default to `none`; add the `groups` scope **and** set a
groups-claim mode when an integration maps groups. The claim is emitted in both the `id_token` and
`/oauth/userinfo` when the `groups` scope was granted. Grafana's `role_attribute_path`, Authentik's group
mapping and Tinyauth's group list all read this standard claim.

## Organization claims

Request the `organizations` scope to have the active organization and the user's memberships included in the
`id_token` and in `/oauth/userinfo`:

```json
{
  "org_id": "org_…",
  "org_slug": "acme",
  "org_role": "org:admin",
  "org_permissions": ["org:sys_memberships:manage"],
  "organizations": [
    { "id": "org_…", "slug": "acme", "name": "Acme", "role": "org:admin" },
    { "id": "org_…", "slug": "beta", "name": "Beta", "role": "org:member" }
  ]
}
```

The active organization is the one the user had selected in the session that authorized the request. If the session
has no active organization, the `org_*` claims are omitted; `organizations` still lists every membership. The
profile and email claims are unaffected.

The device grant has no browser session behind it, so its tokens carry no `sid` and no active organization: the
`organizations` scope then returns the membership list only.

### Organization changes revoke organization authority

When a membership is removed, a user leaves an organization, the organization is deleted, or a membership role
changes, OrbitID revokes that user's codes, access tokens and refresh tokens for every application whose issued
claims can carry organization/group authority — an application that configured the `groups` or `organizations`
scope and whose `groups_claim` is not `none`. Unrelated applications keep their grants and the user's browser
session is not ended. An access JWT that was already issued stays valid until its (short, application-configured)
`exp`; the refresh token is revoked immediately, so the RP cannot mint another and must re-authorize to observe
the new membership state.

## Organization-owned applications

An application with `organization_id` set is limited to that organization's members and to users an operator
granted access (`/v1/oauth_applications/:id/access_grants`). Anyone else gets `access_denied` from `/oauth/authorize`
and `invalid_grant` from `/oauth/token`; applications without an owner stay open to every user. Losing access
revokes the user's codes and tokens for the application. See [APP_ACCESS.md](APP_ACCESS.md).

## RP-initiated logout

Send the browser to `/oauth/end_session` with:

| Parameter | Meaning |
|---|---|
| `id_token_hint` | An ID token OrbitID issued for the user. Its signature and issuer are checked; expiry is deliberately ignored so an old hint still works. |
| `client_id` | Alternative to `id_token_hint` for identifying the application. |
| `post_logout_redirect_uri` | Must be one of the application's `post_logout_redirect_uris`. An unregistered value is refused with `invalid_request` rather than redirected. |
| `state` | Returned on the post-logout URI unchanged. |

When the hint carries a `sid`, OrbitID ends that browser session and revokes the access and refresh tokens
minted from it. Without a hint the endpoint validates the client and redirects, but does not end a session.
Both `GET` and `POST` are accepted; the dashboard's endpoint panel prints the exact URL.

## Device authorization grant (CLI, TV, kiosk)

Enable the grant first (it is off by default, and while off the endpoints return `404` and the token endpoint
returns `unsupported_grant_type`):

```jsonc
// PATCH /v1/instance
{ "oidcProvider": { "deviceAuthorizationEnabled": true } }
```

`deviceCodeLifetimeSeconds` (default 600) and `deviceCodeIntervalSeconds` (default 5) control the code's lifetime
and the minimum polling interval.

### Walk-through

Ask for a device code. Public clients are allowed here and PKCE does not apply:

```bash
curl -s -X POST http://localhost:4000/oauth/device_authorization \
  -d client_id=oa_… \
  -d 'scope=openid email offline_access'
```

```json
{
  "device_code": "odc_…",
  "user_code": "BCDF-2345",
  "verification_uri": "http://localhost:4000/oauth/device",
  "verification_uri_complete": "http://localhost:4000/oauth/device?user_code=BCDF-2345",
  "expires_in": 600,
  "interval": 5
}
```

Show `user_code` and `verification_uri` (or open `verification_uri_complete` as a QR code). The user signs in at
that address and sees the application name and the requested scopes before approving. The page is plain
server-rendered HTML with its script and stylesheet served by the server itself, so it works without any
front-end build and under a strict Content-Security-Policy.

The same flow is available to your own front-end through the Frontend API:

```bash
# confirm the request (cookie authenticated, needs an active session)
curl -s "http://localhost:4000/v1/client/oauth/device?user_code=BCDF-2345" -b "$COOKIE"

# approve or deny
curl -s -X POST http://localhost:4000/v1/client/oauth/device/approve \
  -b "$COOKIE" -H 'Content-Type: application/json' \
  -d '{"user_code":"BCDF-2345","action":"approve"}'
```

Meanwhile the device polls the token endpoint at most once every `interval` seconds:

```bash
curl -s -X POST http://localhost:4000/oauth/token \
  -d grant_type=urn:ietf:params:oauth:grant-type:device_code \
  -d device_code=odc_… -d client_id=oa_…
```

Until approval this returns HTTP 400 with `{"error":"authorization_pending"}`. Polling faster than the interval
returns `slow_down`, and the interval is raised by five seconds for the rest of that code's life (also sent as
`Retry-After`). A denial returns `access_denied`, an expired or already-consumed code returns `expired_token`.
Once approved, the poll returns a normal token set and the device code is consumed: it can never produce a second
one.

User codes are eight characters from an alphabet without look-alikes (`0/O`, `1/I/L`), displayed as `ABCD-EFGH`.
They are short by design, so trying them is limited per IP and per code, and a code is burned after a handful of
attempts. Device codes themselves are stored hashed and compared in constant time.

## Sign in with Apple

Apple is different from the other social providers in two ways.

**The client secret is a signed JWT.** Instead of a static secret, Apple expects an ES256 JWT signed with a `.p8`
key. Set the team id, key id and the key itself on the apple provider:

```jsonc
// PATCH /v1/instance
{
  "social": {
    "apple": {
      "enabled": true,
      "clientId": "com.example.web",       // the Apple Services ID
      "appleTeamId": "TEAM123456",
      "appleKeyId": "KEY7890123",
      "applePrivateKey": "-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----\n"
    }
  }
}
```

The server then mints the secret on demand — `iss` is the team id, `sub` the client id, `aud`
`https://appleid.apple.com`, `exp` at most 180 days out, `kid` in the header — and caches it until shortly before
it expires, so the token endpoint never pays for a signature per request. A pasted key with lost line breaks or
without the PEM header is accepted. If you set `clientSecret` instead, it is used verbatim (for example a secret
you generate elsewhere), and no key is needed.

Register `https://your-instance/v1/oauth_callback/apple` as the return URL in the Apple developer console, and
request the `name` and `email` scopes.

**There is no userinfo endpoint.** The profile comes from the `id_token`, which the server verifies against Apple's
published keys before reading anything from it: signature, `iss` = `https://appleid.apple.com`, `aud` = your client
id, and expiry. An `id_token` that fails any check aborts the sign-in.

Apple sends the user's name only on the **first** authorization, in the `user` form field. Later authorizations
omit it, so the name is stored on the first sign-in and never overwritten with an empty value.

## Token lifetimes

| Item | Lifetime |
|---|---|
| Authorization code | 10 minutes |
| Access token | The application's `access_token_lifetime_seconds` (default 5 minutes for new applications) |
| Refresh token | The application's `refresh_token_lifetime_seconds` (default 30 days), rotated on every use |
| `id_token` | The application's `id_token_lifetime_seconds` (default 1 hour) |
| Refresh retry grace | `oidcProvider.refreshTokenReuseGraceSeconds` (default 30 seconds) |
| Device code | `deviceCodeLifetimeSeconds` (default 10 minutes) |

The refresh-token reuse grace window is instance-wide; the three token lifetimes are per application.

## Client guides

Step-by-step fields for common self-hosted apps:

- [Tinyauth](integrations/tinyauth.md)
- [Authentik (OAuth source and OpenID Connect source)](integrations/authentik.md)
- [Grafana, Gitea/Forgejo, Nextcloud, Portainer, Immich, oauth2-proxy and Traefik](integrations/generic.md)

## Compatibility notes

- `response_mode=form_post` is supported on the authorization endpoint and returns a self-submitting form with
  a CSP that allows only the relying party's origin. When the application shows the interactive consent screen,
  the consent page returns a normal query response after approval.
- `prompt=none`, `prompt=login`, `prompt=consent` and `prompt=select_account` are supported. `login` and
  `select_account` send the browser to the sign-in screen; the return URL has those prompt values and
  `max_age` removed so the authorized request does not loop.
- `max_age` forces a fresh sign-in when the authorizing session's `auth_time` is older.
- `login_hint` is compared with usernames, emails and phone numbers. With `prompt=none`, a hint for a different
  account returns `login_required`; otherwise the browser is sent to sign-in.
- Unknown authorization parameters are ignored. Errors after a valid redirect URI are returned to that URI;
  an unknown `client_id` or an unregistered redirect URI is answered with JSON `400` and never redirected.

## Errors

OAuth endpoints answer with the standard `{ "error": "...", "error_description": "..." }` body, not the OrbitID
error envelope. `invalid_client` also sets `WWW-Authenticate: Basic realm="orbitid"`. Introspection returns
`{"active": false}` — never an error — for unknown, foreign, expired or revoked tokens, as RFC 7662 requires.

## Security notes

- Authorization codes, access tokens, refresh tokens and device codes are stored only as SHA-256 hashes and
  compared in constant time with `safeEqual`. A database dump does not hand out working tokens.
- Public clients cannot introspect: introspection requires a confidential client. Revocation accepts a public
  client's own `client_id`, but a token belonging to another client is ignored rather than revoked.
- Revoking a refresh token revokes its whole rotation family. Reusing a rotated-out refresh token revokes it too
  when the retry grace window (measured from the original consumption) has passed; inside the window it is a
  retry that returns the same successor (see above).
- A seeded database dump does not hand out working tokens: tokens are stored as SHA-256 hashes. The one exception
  is the successor refresh token kept **encrypted** (with `ORBITID_ENCRYPTION_KEY`) for the 30 s retry window, so
  an idempotent retry can return the same token; it is useless without the encryption key.
- The device page only accepts a decision posted from the instance's own origin (checked with `Origin` and
  `Sec-Fetch-Site`), so another site cannot approve a code it created for a signed-in visitor.
- The device verification page is rendered by the server under
  `default-src 'none'; script-src 'self'; style-src 'self'; frame-ancestors 'none'`, with no inline script or
  style. Every interpolated value — application name, scopes, codes — is HTML-escaped.
