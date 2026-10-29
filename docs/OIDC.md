# OIDC and OAuth 2.0 provider

OrbitID can act as the identity provider for your own applications. Users sign in on OrbitID (password, social,
enterprise SSO, second factor…) and your application receives standard OIDC tokens. No extra process or service
is needed: the provider is part of the server and lives under `/oauth` and `/.well-known`.

Everything below is standard OIDC/OAuth 2.0, so any conforming client library works.

## Register an application

Applications are managed with the Backend API (secret key):

```bash
curl -X POST http://localhost:4000/v1/oauth_applications \
  -H "Authorization: Bearer sk_test_..." \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My dashboard",
    "redirect_uris": ["https://app.example.com/auth/callback"],
    "scopes": "openid profile email organizations offline_access",
    "public": false,
    "consent_screen_enabled": true,
    "pkce_required": true
  }'
```

The response contains `client_id` and, for a confidential client, `client_secret`. The secret is shown **once**;
store it like a password. `POST /v1/oauth_applications/:id/rotate_secret` issues a new one and invalidates the old
secret immediately.

| Field | Meaning |
|---|---|
| `redirect_uris` | Exact match only. A request for any other URI is rejected before the user sees anything. |
| `scopes` | Custom scopes on top of `openid profile email organizations offline_access`. Any other scope is refused. |
| `public` | A browser/mobile client without a secret. PKCE is then mandatory. |
| `pkce_required` | Requires PKCE (S256) even for confidential clients. On by default. |
| `consent_screen_enabled` | Shows the consent screen the first time a user authorizes the app. |

Only `code_challenge_method=S256` is accepted; `plain` is refused, and a request with no challenge is refused for
public clients and for clients with `pkce_required`.

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /.well-known/openid-configuration` | Discovery document |
| `GET /oauth/jwks` | Public signing keys (RS256) |
| `GET /oauth/authorize` | Authorization code flow (login + consent) |
| `POST /oauth/token` | `authorization_code`, `refresh_token`, and `urn:ietf:params:oauth:grant-type:device_code` |
| `GET`/`POST /oauth/userinfo` | Claims for an access token |
| `POST /oauth/introspect` | RFC 7662 token introspection |
| `POST /oauth/revoke` | RFC 7009 token revocation |
| `POST /oauth/device_authorization` | RFC 8628 device flow (when enabled) |
| `GET /oauth/device` | Device verification page (the `verification_uri`) |

Client authentication is `client_secret_basic` or `client_secret_post` (or `none` for public clients).

The authorization code is single-use, lives 10 minutes, and is bound to the `redirect_uri` and PKCE verifier of the
request. Presenting it twice — or with the wrong redirect URI or verifier — returns `invalid_grant`.

Refresh tokens rotate on every use and are bound to a *token family*: presenting a rotated-out refresh token is
treated as theft and revokes the whole family, including its access tokens.

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
| `iat`, `exp` | Issued at / expiry (one hour) |
| `jti` | Grant id |
| `sid` | The OrbitID session the grant came from, when there was one |
| `org_*`, `organizations` | Only with the `organizations` scope (see below) |

Resource servers can verify these offline with the JWKS. JWT access tokens are still recorded in the grant table,
so revocation keeps working: after `POST /oauth/revoke`, `/oauth/userinfo` and `/oauth/introspect` both reject the
token, even though its signature is still valid. Revocation wins.

Opaque and JWT tokens are both accepted by `/oauth/userinfo`, so switching formats does not break clients that
already hold a token.

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
| Access token | 1 hour |
| Refresh token | 30 days, rotated on every use |
| `id_token` | 1 hour |
| Device code | `deviceCodeLifetimeSeconds` (default 10 minutes) |

## Errors

OAuth endpoints answer with the standard `{ "error": "...", "error_description": "..." }` body, not the OrbitID
error envelope. `invalid_client` also sets `WWW-Authenticate: Basic realm="orbitid"`. Introspection returns
`{"active": false}` — never an error — for unknown, foreign, expired or revoked tokens, as RFC 7662 requires.

## Security notes

- Authorization codes, access tokens, refresh tokens and device codes are stored only as SHA-256 hashes and
  compared in constant time with `safeEqual`. A database dump does not hand out working tokens.
- Public clients cannot introspect: introspection requires a confidential client. Revocation accepts a public
  client's own `client_id`, but a token belonging to another client is ignored rather than revoked.
- Revoking a refresh token revokes its whole rotation family, and reusing a rotated-out refresh token revokes it
  too.
- The device page only accepts a decision posted from the instance's own origin (checked with `Origin` and
  `Sec-Fetch-Site`), so another site cannot approve a code it created for a signed-in visitor.
- The device verification page is rendered by the server under
  `default-src 'none'; script-src 'self'; style-src 'self'; frame-ancestors 'none'`, with no inline script or
  style. Every interpolated value — application name, scopes, codes — is HTML-escaped.
