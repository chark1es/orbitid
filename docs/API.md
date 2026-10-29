# OrbitID HTTP API

The server exposes one HTTP origin with four surfaces:

| Surface | Paths | Who calls it | Credential |
|---|---|---|---|
| Frontend API | `/v1/client/*` | Browsers and devices, through `@orbitid/js`, `@orbitid/react` or `@orbitid/nextjs` | `__client` cookie (set by the server) |
| Backend API | `/v1/*` | Your server, through `@orbitid/backend` or plain HTTP | `Authorization: Bearer sk_...` |
| OAuth / OIDC provider | `/oauth/*`, `/.well-known/*` | Third-party OAuth clients | OAuth access token, or none for the protocol endpoints |
| Health and docs | `/health`, `/docs`, `/v1/openapi.json` | Load balancers, people | None |

The full reference is generated from the server's route table:

- **`/docs`** on your instance is a readable reference: search, one collapsible section per operation, request and
  response schema trees, and a copyable `curl` example.
- **`/v1/openapi.json`** is the same document as OpenAPI 3.1, public and cacheable. Point your own tooling at it.
- **`docs/openapi.json`** in the repository is a snapshot written by `bun run openapi:export` (in
  `packages/server`). CI fails when it is out of date, so it always describes the code you are running.

## Authentication

### Frontend API: the client cookie

Every browser gets an opaque **client** on first use. `GET /v1/client` creates one if the request has none and sets
it as an httpOnly cookie:

```
Set-Cookie: __client=<opaque token>; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000
```

Send it back on every call. `fetch` does that for you with `credentials: "include"` on a same-origin page, or with
CORS credentials from an allowed origin. Non-browser devices may instead send the client token as
`Authorization: Bearer <client token>`; the server accepts that and rejects values that start with `sk_` or `pk_`.
The server also reads a client token from an `X-OrbitID-Client` header, but the browser SDK uses that header only to
identify itself (`@orbitid/js/0.1.0`), so treat it as informational rather than a credential.

The client holds **sessions**. A session is what makes a user signed in. The Frontend API returns the updated client
alongside sign-in, sign-up and session mutations as `{ response, client }`, so a UI can refresh its state in one
round trip.

### Backend API: the secret key

Every route under `/v1` outside `/v1/client` needs the instance secret key, except the browser-facing and discovery routes, which carry no secret key: `/v1/jwks`, `/v1/verify` (the magic-link landing page), `/v1/oauth_callback/{provider}`, `/v1/saml/{id}/metadata`, `/v1/saml/{id}/sso`, `/v1/saml/{id}/acs`, `/v1/openapi.json` and the three `/v1/operator_sessions` operations. The `/oauth/*` and `/.well-known/*` protocol endpoints authenticate with OAuth client credentials or not at all, as their standards define. The reference at `/docs` marks each operation with its security requirement.

```
Authorization: Bearer sk_live_...
```

Requests without it, or with the wrong key, get `401` with `errors[0].code = "secret_key_invalid"`.

The one other accepted credential is the dashboard's operator cookie, `__orbit_operator`. It exists so that a
browser never holds the secret key: `POST /v1/operator_sessions` takes the key once and returns an httpOnly cookie
(`Path=/v1`, `SameSite=Strict`, `Secure` over https, 8 hours). The server stores only the token's sha256 hash, and
the cookie is honoured only from this instance's own origin. `GET /v1/operator_sessions/current` reports the live
session; `DELETE` revokes it. Rotating the secret key ends every operator session. Servers and SDKs should keep
using the bearer key; the cookie is not a substitute for it outside a same-origin browser.

**Never put the secret key in a browser.** It grants full read and write access to every user, session,
organization, webhook and setting on the instance. It belongs in the environment of a server you control. A browser
that needs to talk to OrbitID directly uses the Frontend API and the publishable key, which is public and only
identifies the instance.

The Backend API also returns fields the Frontend API hides, most importantly `private_metadata` on users and
organizations.

### Session tokens

`POST /v1/client/sessions/:id/tokens` mints a short-lived session JWT: RS256, 60 seconds, one `kid` from the
instance's JWKS. The browser SDK refreshes it about every 50 seconds and writes it to the `__session` cookie on your
app's origin; `__client_uat` carries the session start time in Unix seconds so server rendering can tell whether
anyone is signed in without verifying a token.

Verify tokens offline:

- `GET /.well-known/jwks.json` (also `/v1/jwks`) for the public keys.
- `jose`/`jwtVerify`, or `verifyToken` from `@orbitid/backend`.
- Check `iss` against your instance URL, `aud`/`azp` against your app origin, and expiry with a little clock skew.

Rotating a signing key with `POST /v1/instance/signing_keys/rotate` keeps the old key in the JWKS until its tokens
expire, so rotation does not invalidate live sessions.

### Rate limits

Sensitive endpoints are rate limited with a fixed-window counter. When you exceed one the answer is `429` with
`errors[0].code = "rate_limit_exceeded"` and a `Retry-After` header in seconds. Check for `429` and `Retry-After`
before assuming any response is a bug; sign-in, sign-up, code verification, session-token minting and the waitlist
are the endpoints most likely to hit a limit on a busy page.

## Conventions

### Errors

Every JSON endpoint answers errors with the same envelope:

```json
{
  "errors": [
    {
      "code": "form_password_incorrect",
      "message": "Password is incorrect",
      "long_message": "The password does not match the one on file for this account.",
      "meta": { "param_name": "password" }
    }
  ],
  "trace_id": "V1StGXR8_Z5jdHi6B"
}
```

- `code` is stable; branch on it, not on the message.
- `message` is short and safe to show to an end user.
- `long_message` and `meta` are optional. `meta.param_name` names the offending field.
- A validation failure can return several entries in `errors`.
- `trace_id` identifies the request in the server log. Include it in bug reports.

| Status | Meaning |
|---|---|
| 400 | The request could not be read: malformed JSON, an unparsable body, an invalid query value. Or an OAuth protocol error. |
| 401 | Missing or invalid credentials. |
| 403 | Authenticated but not allowed: missing organization permission, disabled feature, or a session that still has to enrol a second factor (`session_pending`). |
| 404 | The resource does not exist, or belongs to someone else. |
| 409 | Conflict with existing state: duplicate record, already a member, last admin, slug taken. |
| 422 | Validation failed. `meta.param_name` says which field. |
| 429 | Rate limited; see `Retry-After`. |

OAuth protocol endpoints (`/oauth/token`, `/oauth/revoke`, `/oauth/introspect`, `/oauth/m2m/token`) use the OAuth
error shape instead: `{ "error": "invalid_request", "error_description": "..." }`.

### Pagination

Backend API list endpoints take `limit` (1–500, default 10), `offset` (default 0) and `order_by`
(`-created_at`, `created_at`, `+name`; an unknown field falls back to the endpoint's default) and return:

```json
{ "data": [ ... ], "total_count": 132 }
```

`GET /v1/users` is the exception: without `?paginated=true` it returns a bare array with the total in the
`x-total-count` header, which is what the SDK expects. Add `?paginated=true` to get `{ data, total_count }`.

Frontend API lists return `{ "response": [ ... ] }`, or `{ "data": [], "total_count": n }` when you send
`?paginated=true`. They accept `limit`, `offset` and `order_by` too.

### Ids

Ids are opaque, prefixed strings; the prefix tells you the object type: `user_...`, `sess_...`, `client_...`,
`org_...`, `orgmem_...` (membership), `orginv_...` (organization invitation), `orgdmn_...` (domain), `role_...`,
`perm_...`, `inv_...` (instance invitation), `wle_...` (waitlist), `we_...` (webhook endpoint), `whd_...`
(delivery), `ak_...` (API key), `mch_...` (machine), `ent_...` (enterprise connection), `oa_...` (OAuth
application). Store them as strings; never parse them.

### Timestamps and field names

All timestamps in JSON and in the database are Unix epoch **milliseconds** (integers). Two exceptions, because the
standards require it: OAuth `exp`/`iat` claims and the `svix-timestamp` webhook header are epoch **seconds**.

JSON is `snake_case` (`first_name`, `created_at`, `email_address`). The SDKs translate to camelCase for you; plain HTTP
sees snake_case.

### Request bodies

Send `application/json`, or `application/x-www-form-urlencoded` — both are parsed, which makes plain HTML forms work.
An unknown field is ignored, not rejected. A missing required field or a bad value returns `422` with
`meta.param_name`.

## Quick start with curl

Everything below assumes `ORBITID_URL=https://auth.example.com` and a secret key in `ORBITID_SECRET_KEY`. The
publishable key is on `/health` and in the dashboard.

### 1. Sign up and get a session (Frontend API)

```bash
# Create an account. Keep the returned client cookie in a jar.
curl -sS -c jar.txt -X POST "$ORBITID_URL/v1/client/sign_ups" \
  -H "Content-Type: application/json" \
  -d '{"email_address":"ada@example.com","password":"Sup3rSecret!","first_name":"Ada"}'

# Send the verification code to the address.
curl -sS -b jar.txt -c jar.txt -X POST "$ORBITID_URL/v1/client/sign_ups/$SIGN_UP_ID/prepare_verification" \
  -H "Content-Type: application/json" \
  -d '{"strategy":"email_code"}'

# Submit it. When nothing else is missing the sign-up completes and creates a session.
curl -sS -b jar.txt -c jar.txt -X POST "$ORBITID_URL/v1/client/sign_ups/$SIGN_UP_ID/attempt_verification" \
  -H "Content-Type: application/json" \
  -d '{"strategy":"email_code","code":"123456"}'

# Mint a session JWT for your app to verify.
curl -sS -b jar.txt -X POST "$ORBITID_URL/v1/client/sessions/$SESSION_ID/tokens" \
  -H "Content-Type: application/json" -d '{}'
```

The responses carry `response` (the sign-up or session) and `client` (the whole client state). Read
`response.status` to know where the flow is: `missing_requirements` → fill or verify, `complete` → signed in.

Signing in later is the same shape with `/v1/client/sign_ins`:

```bash
curl -sS -c jar.txt -X POST "$ORBITID_URL/v1/client/sign_ins" \
  -H "Content-Type: application/json" \
  -d '{"identifier":"ada@example.com","strategy":"password","password":"Sup3rSecret!"}'
```

### 2. Create and list users (Backend API)

```bash
# Create a user with a verified email address and a password.
curl -sS -X POST "$ORBITID_URL/v1/users" \
  -H "Authorization: Bearer $ORBITID_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "email_address": ["ada@example.com"],
    "password": "Sup3rSecret!",
    "first_name": "Ada",
    "last_name": "Lovelace",
    "public_metadata": {"tier": "pro"},
    "private_metadata": {"crm_id": "c_123"}
  }'

# List users, paginated, newest first.
curl -sS -g "$ORBITID_URL/v1/users?paginated=true&limit=20&order_by=-created_at" \
  -H "Authorization: Bearer $ORBITID_SECRET_KEY"

# Find one user by email address.
curl -sS -g "$ORBITID_URL/v1/users?email_address=ada@example.com" \
  -H "Authorization: Bearer $ORBITID_SECRET_KEY"
```

`POST /v1/users` accepts either `password` or a `password_digest` with `password_hasher` (for migrating from another
system), never both. `public_metadata` is visible to the browser, `private_metadata` stays server-side, and
`unsafe_metadata` is the one the user themselves may write.

### 3. Verify a session token with JWKS

```bash
# Cache the keys; they only change when a signing key is rotated.
curl -sS "$ORBITID_URL/.well-known/jwks.json"
```

```js
import { createRemoteJWKSet, jwtVerify } from "jose";

const jwks = createRemoteJWKSet(new URL("https://auth.example.com/.well-known/jwks.json"));

export async function userIdFromRequest(request) {
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!token) return null;
  const { payload } = await jwtVerify(token, jwks, {
    issuer: "https://auth.example.com",
    audience: "https://app.example.com",
    clockTolerance: 5,
  });
  return payload.sub;
}
```

`@orbitid/backend` wraps this as `verifyToken(token, { jwksUrl, audience, authorizedParties })` and
`authenticateRequest(request, options)` when you also want the signed-out case handled.

## Webhooks

Register an endpoint with the Backend API and choose the event types it should receive:

```bash
curl -sS -X POST "$ORBITID_URL/v1/webhooks/endpoints" \
  -H "Authorization: Bearer $ORBITID_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://app.example.com/webhooks","event_types":["user.created","session.created"]}'
```

The response contains the signing `secret` (`whsec_...`). It is shown on creation, on `PATCH` with
`rotate_secret: true`, from `POST .../rotate_secret`, and from `GET /v1/webhooks/endpoints/:id/secret`. Store it in
your app's environment; treat a rotation as a credential change.

### Events

`user.created`, `user.updated`, `user.deleted`, `session.created`, `session.ended`, `session.removed`,
`session.revoked`, `email.created`, `sms.created`, `organization.created`, `organization.updated`,
`organization.deleted`, `organizationMembership.created`, `organizationMembership.updated`,
`organizationMembership.deleted`, `organizationInvitation.created`, `organizationInvitation.accepted`,
`organizationInvitation.revoked`, `organizationDomain.created`, `organizationDomain.updated`,
`organizationDomain.deleted`, `role.created`, `role.updated`, `role.deleted`, `permission.created`,
`permission.updated`, `permission.deleted`, `waitlistEntry.created`, `waitlistEntry.updated`,
`invitation.created`, `invitation.accepted`, `invitation.revoked`, `apiKey.created`, `apiKey.revoked`.

An endpoint with an empty `event_types` list receives every event. `GET /v1/webhooks/event_types` returns the list at
runtime.

### Delivery

Each event is POSTed as JSON:

```json
{
  "id": "whev_...",
  "object": "event",
  "type": "user.created",
  "data": { "object": "user", "id": "user_...", "...": "..." },
  "timestamp": 1750000000000,
  "instance_id": "default"
}
```

`data` is the resource in the same shape the Backend API returns, so a `user.created` payload includes
`private_metadata`.

### Signing

Signatures are Svix-compatible. Every request carries:

| Header | Value |
|---|---|
| `svix-id` | The event id, also `id` in the body. |
| `svix-timestamp` | Unix **seconds** when the attempt was made. |
| `svix-signature` | `v1,<base64 HMAC-SHA256>`; several space-separated signatures are allowed. |

The signed content is `` `${svix-id}.${svix-timestamp}.${rawBody}` `` and the key is the secret's base64 payload
after the `whsec_` prefix:

```js
import { verifyWebhook } from "@orbitid/backend/webhooks";

const ok = verifyWebhook(request, process.env.ORBITID_WEBHOOK_SECRET); // raw body required
```

Or by hand:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

export function verify(rawBody, headers, secret) {
  const id = headers["svix-id"];
  const timestamp = headers["svix-timestamp"];
  const signatures = String(headers["svix-signature"] ?? "").split(" ");
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!id || !timestamp || age > 300) return false; // reject replays
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest("base64");
  return signatures.some((part) => {
    const [version, value] = part.split(",");
    return version === "v1" && value
      && value.length === expected.length
      && timingSafeEqual(Buffer.from(value), Buffer.from(expected));
  });
}
```

Verify against the **raw** request body, before JSON parsing.

### Retries

A delivery counts as successful on any `2xx`. Anything else, including a timeout after 10 seconds, is retried after
`5s`, `5m`, `30m`, `2h`, `5h` and `10h`; the sixth failure marks it failed. Your endpoint should treat `svix-id` as
an idempotency key and answer `2xx` quickly — do the real work asynchronously.

`GET /v1/webhooks/endpoints/:id/deliveries` shows the attempt history with response codes and bodies,
`POST /v1/webhooks/deliveries/:id/retry` re-queues one, and `POST /v1/webhooks/endpoints/:id/test` sends a test event
so you can exercise your signature check.

## Other flows

- **Organizations and RBAC**: `/v1/client/organizations/*` for the browser (memberships, invitations, domains, roles,
  membership requests), `/v1/organizations/*` for the Backend API. Role changes emit
  `organizationMembership.updated`, and the JWT carries `org_id`, `org_role` and `org_permissions` so your app can
  check permissions without another request.
- **Impersonation**: `POST /v1/actor_tokens` creates a one-time token; redeem it through `POST /v1/client/sign_ins`
  with `strategy: "ticket"`. The resulting session carries the `act` claim naming the actor.
- **API keys**: create them for a user or an organization and verify a presented key with
  `POST /v1/api_keys/verify`. The secret is shown once; only a hash is stored.
- **Machines (M2M)**: `POST /v1/m2m/machines` returns the machine secret once. The machine mints its own tokens with
  `POST /oauth/m2m/token` (`client_credentials`) and never needs the instance secret key.
- **OIDC provider**: publish `/.well-known/openid-configuration` to your clients. Authorization code flow, PKCE
  `S256` for public clients, `id_token` signed by the instance key, `userinfo`, `revoke` and `introspect` behave as
  the standards describe. Manage applications with `/v1/oauth_applications`.
- **Enterprise SSO**: SAML 2.0 and OIDC connections created with `/v1/enterprise_connections`. Point the identity
  provider at `GET /v1/saml/:id/metadata`, and start a browser flow at `/v1/client/enterprise/start` or
  `/v1/saml/:id/sso`.
- **Testing tokens**: `POST /v1/testing_tokens` issues a one-hour token for test suites that bypasses bot protection.
  It only exists when testing tokens are enabled; never enable them in production.

## Staying current

- Read `/docs` on the instance you are integrating with. It always matches the running server.
- `docs/openapi.json` is regenerated with `bun run openapi:export` from `packages/server`; CI fails when the committed
  file is stale, and a test fails when a registered route is missing from the document.
- Versioning: the API is `0.1.0`. Additive changes (new fields, new endpoints, new enum values) can land in a patch
  release; read fields you know and branch on error `code`s.
