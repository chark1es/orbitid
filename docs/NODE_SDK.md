# `@orbitid/node` reference

Longer material for the Node SDK. The quick start and one example per adapter are in
[`packages/node/README.md`](../packages/node/README.md).

## What the package is

`@orbitid/node` is the server-side SDK for plain Node servers and the popular Node frameworks. It
wraps [`@orbitid/backend`](../packages/backend) rather than re-implementing it:

| Concern | Where it lives |
|---|---|
| Typed Backend API client (`users`, `organizations`, `sessions`, `webhooks`, …) | `@orbitid/backend` |
| Svix-compatible signature scheme | `@orbitid/backend/webhooks` |
| Claims → `has()` (roles, permissions, features, reverification) | `@orbitid/backend` |
| Session JWT verification, JWKS caching, request auth, adapters, webhook handler | this package |

The SDK has no framework dependency. Express, Fastify and Hono adapters are written against
structural types (`{ headers }`, `status().json()`, `decorateRequest`, `c.set`), so they compile
against whatever version of the framework you already have.

## Configuration

```ts
createOrbitId({
  secretKey,        // required unless ORBITID_SECRET_KEY is set
  apiUrl,           // optional; defaults to the publishable key's URL
  jwksUrl,          // optional; defaults to `${apiUrl}/.well-known/jwks.json`
  publishableKey,   // optional; only used to derive apiUrl
  audience,         // optional; for tokens with an `aud`
  clockToleranceSeconds, // optional; default 5
  authorizedParties,     // optional; accepted `azp` values
  webhookSecret,    // optional; `whsec_…`
  fetch,            // optional; transport override (tests, proxies)
  timeoutMs,        // optional; default 10_000
  retries,          // optional; idle GET retries, default 2
  retryDelayMs,     // optional; base backoff, default 150
  jwksMaxAgeMs,     // optional; default 600_000
  jwksCooldownMs,   // optional; default 30_000
});
```

### Environment variables

| Variable | Scope | Required | Meaning |
|---|---|---|---|
| `ORBITID_SECRET_KEY` | `backend-sdk` (secret) | **yes** | Backend API secret. Never ships to a browser. |
| `ORBITID_API_URL` | `backend-sdk` | no | Base URL of the instance. |
| `ORBITID_JWKS_URL` | `backend-sdk` | no | JWKS endpoint override. |
| `ORBITID_PUBLISHABLE_KEY` | `backend-sdk` (public value) | no | Used only to derive `ORBITID_API_URL`. |
| `ORBITID_AUDIENCE` | `backend-sdk` | no | Expected `aud` claim. |
| `ORBITID_WEBHOOK_SECRET` | `backend-sdk` (secret) | no | Default `whsec_…` for `webhooks.verify()`. |

Options always win over the environment. `createOrbitId()` fails at call time (not on the first
request) when the secret key is absent or obviously wrong, and never echoes it.

### API URL resolution

1. `apiUrl` option.
2. `ORBITID_API_URL`.
3. The URL encoded in `publishableKey` / `ORBITID_PUBLISHABLE_KEY` (`pk_(test|live)_<base64url(url)>`).
4. The Backend SDK's default.

## Session verification

`verifyToken(token)` and `authenticate(request)` share one verifier:

1. **Algorithm.** Only asymmetric algorithms are accepted: RS256, ES256, ES384, ES512, EdDSA. `alg:
   none` and symmetric algorithms are refused before any key lookup, so a token cannot downgrade or
   use the public key as an HMAC secret.
2. **Key.** The token's `kid` selects a key from the cached JWKS. A token without `kid` is accepted
   only when the instance publishes exactly one key (JWT templates can omit it).
3. **Signature.** Verified with `jose`.
4. **Issuer.** Must equal the configured API URL — the value the server uses for `iss`.
5. **Audience.** Only checked when you configure one. Session tokens carry no `aud`; a token that
   does carry one and is presented to a verifier without a configured audience is refused as
   "not a session token" (this rejects machine and OIDC tokens).
6. **Time.** `exp` and `nbf` with the configured clock tolerance.
7. **Claims.** `sub` and `sid` must be strings. `sts: "pending"` is refused: a session waiting for a
   second factor is not signed in.
8. **Authorized party.** When `authorizedParties` is set, `azp` must match one of them.

Failure reasons, all on `OrbitIdError.reason`: `token-missing`, `token-expired`,
`token-not-active-yet`, `invalid-signature`, `invalid-algorithm`, `invalid-issuer`,
`invalid-audience`, `invalid-authorized-party`, `invalid-claims`, `not-session-token`,
`session-pending`, `no-matching-key`, `jwks-fetch-failed`.

### Token sources

- `Authorization: Bearer <jwt>` wins.
- Otherwise the `__session` cookie written by the browser SDK.
- A malformed `Authorization` header (wrong scheme, empty value) falls through to the cookie.

Header access works for a Fetch `Headers`, a Node header bag (`Record<string, string | string[]>`)
and framework wrappers, so the same `authenticate()` serves `IncomingMessage`, `Request`, Express,
Fastify and Hono.

### JWKS caching

- The document is fetched on first use and re-fetched when older than `jwksMaxAgeMs` (10 minutes).
- An unknown `kid` triggers one immediate re-fetch (key rotation), at most once per `jwksCooldownMs`
  (30 seconds). Tokens with made-up `kid`s inside that window are answered from the cache, so a
  flood of forged tokens cannot turn into a flood of requests to the auth server.
- Concurrent refreshes are coalesced into one request.
- When a refresh fails, previously cached keys keep verifying tokens (an auth-server outage does not
  sign everyone out), but the error surfaces when nothing has ever been cached.

## `authenticate()` contract

| Situation | Result |
|---|---|
| No token | `null` |
| Valid session | `AuthContext` |
| Expired, not-yet-valid, bad signature, wrong issuer/audience/party, unknown `kid`, malformed, pending session | `null` |
| JWKS unreachable, transport failure, configuration error | throws `OrbitIdError` |

The adapters map `null` to `401` and a throw to `503`, so a broken JWKS never looks like "signed out"
and never leaks the underlying error to the caller. Pass `onError` to an adapter to log the detail.

`AuthContext`:

```ts
{
  userId, sessionId, orgId, orgRole, orgSlug, orgPermissions,
  roles,        // instance-wide ("app:...") role keys assigned by an operator
  rolePermissions, // permissions granted by `roles`, independent of the organization
  actor,        // historical impersonation context; no new session carries one
  claims,       // the raw SessionClaims
  has(check),   // { role?, permission?, feature?, reverification? } → boolean
}
```

`has()` reads `org_role`, `org_permissions` and `fva` from the claims, including `org:feature:*`
wildcards.

## Adapters

All three answer the same bodies, matching the server's error shape:

```json
{ "errors": [{ "code": "authentication_invalid", "message": "Authentication required" }] }
```

| Status | Code | When |
|---|---|---|
| 401 | `authentication_invalid` | No usable session. Adds `www-authenticate: Bearer realm="orbitid"`. |
| 403 | `org_permission_required` | Signed in, permission missing. Names the permission. |
| 403 | `not_allowed_access` | Signed in, role does not match. |
| 503 | `authentication_unavailable` | Verification could not run. Detail goes to `onError`. |

Every response is `cache-control: private, no-store`. No token, key, claim or server detail is ever
written to a response body or header.

### Express / `node:http`

| Factory | Behaviour |
|---|---|
| `expressMiddleware()` | Sets `req.auth` (caller or `null`) and always calls `next()`. |
| `requireAuth()` | 401 unless signed in. |
| `requirePermission(permission)` | 401 signed out, 403 when any listed permission is missing. |
| `requireRole(role)` | 401 signed out, 403 when none of the roles match. |
| `webhookHandler(onEvent, options)` | Verifies the raw body, calls `onEvent`, answers 200. |
| `getAuth(req)` | Returns what an adapter attached. |
| `getAuth(req, orbit)` | Verifies on demand and returns `AuthContext \| null`. |

`requirePermission` / `requireRole` accept a string or an array.

`webhookHandler` requires the raw body:

```ts
app.post("/api/webhooks", express.raw({ type: "application/json" }), orbit.webhookHandler(async (event) => { … }));
```

If a JSON parser ran first, the handler answers 400 and reports `webhook_raw_body_missing` through
`onError`; it does not try to re-serialize the object, because that would not match the signature.

### Fastify

| Factory | Behaviour |
|---|---|
| `fastifyPlugin()` | `decorateRequest("auth", null)` + a `preHandler` hook that fills it in for every route. |
| `fastifyRequireAuth()` | Route-level `preHandler`; 401 unless signed in. |
| `fastifyRequirePermission(permission)` | 401 signed out, 403 when a permission is missing. |
| `fastifyRequireRole(role)` | 401 signed out, 403 when the role does not match. |

Route-level hooks work without registering the plugin: they verify and attach `request.auth`
themselves when it has not been set yet.

### Hono

| Factory | Behaviour |
|---|---|
| `honoMiddleware()` | Sets `c.get("auth")` (caller or `null`) and continues. |
| `honoRequireAuth()` | Returns a 401 response and stops the chain. |
| `honoRequirePermission(permission)` | 401 signed out, 403 when a permission is missing. |
| `honoRequireRole(role)` | 401 signed out, 403 when the role does not match. |

Use `new Hono<{ Variables: OrbitIdHonoVariables }>()` for typed `c.get("auth")`. The adapter reads the
original Fetch `Request` from `c.req.raw` and falls back to `c.req.header()` when that is absent
(some hosts do not expose `raw`).

## Webhooks

The signature covers the exact bytes the server sent: `v1,<base64 hmac-sha256(secretBytes,
"id.timestamp.body")>`. Headers are `svix-id`, `svix-timestamp` and `svix-signature`; the secret is
`whsec_<base64>`. Verification rejects:

- missing headers (`webhook_verification_failed`),
- a timestamp more than 5 minutes away (replay protection),
- a signature that does not match, including one computed with a different secret,
- a body that is not JSON, or JSON without an event `type`.

A verified delivery is returned as the parsed `WebhookEvent`.

## Transport

- **Timeout.** Every attempt is aborted after `timeoutMs` (default 10 s) and reported as
  `request_timeout`.
- **Retries.** Only `GET`. Network failures, timeouts, `429` and `5xx` are retried with exponential
  backoff (`retryDelayMs * 2^attempt`), honouring `Retry-After` up to 5 s. `POST`, `PATCH`, `PUT`
  and `DELETE` are single-shot, so a create is never applied twice.
- **User-Agent.** `orbitid-node/<version>` on every request, including the JWKS fetch. An explicit
  header from the caller is preserved.
- **Error mapping.** Non-2xx responses are parsed as `{ errors, trace_id }`. A body that does not
  match (a proxy's HTML error page, an empty 502) becomes a generic `unknown_error` with the status,
  so internals never reach your code or your users.

### `OrbitIdError`

```ts
class OrbitIdError extends Error {
  status: number | null;    // HTTP status, or null when no response arrived
  code: string;             // API error code or an SDK code
  reason: OrbitIdErrorReason | null;
  traceId: string | null;
  meta: ApiErrorItem["meta"] | null;
  errors: ApiErrorItem[];   // every error item the server returned
  toBody(): ApiErrorBody;   // { errors, trace_id }, ready to send to a caller
  hasCode(code: string): boolean;
}
```

SDK codes: `secret_key_missing`, `secret_key_invalid`, `configuration_invalid`,
`webhook_secret_missing`, `webhook_verification_failed`, `webhook_raw_body_missing`,
`request_timeout`, `network_error`, `unknown_error`, `jwks_fetch_failed`, `jwks_no_matching_key`,
`jwks_invalid`, plus the token codes listed under session verification.

## Machines and API keys

```ts
await orbit.m2m.verify(token);   // POST /v1/m2m/tokens/verify
await orbit.apiKeys.verify(key); // POST /v1/api_keys/verify
```

Both are live server checks, so revocation and expiry take effect immediately. They need the secret
key and therefore never belong in a browser.

## Testing your integration

The package's own tests boot the real server from `@orbitid/server` on a random port and use real
signing keys, real JWKS, real sessions and real webhook secrets — see
`packages/node/test/helpers/server.ts` for the harness. There is nothing to mock: point
`createOrbitId()` at your test instance.

## Not in this package

- Browser sign-in and components: use `@orbitid/js` and `@orbitid/react`.
- Next.js middleware and server components: use `@orbitid/nextjs`.
- OIDC/SAML flows: the server implements them; this SDK consumes the resulting session tokens.
