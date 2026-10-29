# @orbitid/node

Batteries-included OrbitID SDK for Node servers: the typed Backend API client, offline session
verification, request authentication, webhook verification, machine-token and API-key checks, and
adapters for Express, Fastify and Hono — with no framework dependency.

Built on [`@orbitid/backend`](../backend): the API client and the Svix-compatible webhook scheme come
from there, so behaviour matches the rest of the stack.

## Install

```bash
bun add @orbitid/node
# or: npm install @orbitid/node
```

Node 20 or newer. The package ships TypeScript source (`exports` points at `./src/index.ts`), like
the other OrbitID SDKs.

## Configure

```ts
import { createOrbitId } from "@orbitid/node";

const orbit = createOrbitId();
// reads ORBITID_SECRET_KEY and ORBITID_API_URL
```

`createOrbitId()` throws at startup when the secret key is missing, so a misconfigured deploy fails
immediately instead of on the first request. The key is never logged, never included in an error and
never returned.

| Option | Environment variable | Required | Notes |
|---|---|---|---|
| `secretKey` | `ORBITID_SECRET_KEY` | **Yes** | `sk_test_…` / `sk_live_…`. A `pk_…` key is rejected: that one belongs in the browser. |
| `apiUrl` | `ORBITID_API_URL` | **Yes**, unless a publishable key is given | URL of your OrbitID server. There is no hosted default: without it (or a publishable key to read it from) `createOrbitId()` throws. |
| `jwksUrl` | `ORBITID_JWKS_URL` | No | Defaults to `${apiUrl}/.well-known/jwks.json`. |
| `publishableKey` | `ORBITID_PUBLISHABLE_KEY` | No | A stand-in for `apiUrl`: the server URL is read from it. |
| `audience` | `ORBITID_AUDIENCE` | No | Expected `aud`. Leave unset for session tokens, which carry none. |
| `webhookSecret` | `ORBITID_WEBHOOK_SECRET` | No | `whsec_…`. Without it `webhooks.verify()` throws a configuration error. |
| `clockToleranceSeconds` | — | No | Clock skew allowed for `exp`/`nbf`. Default `5`. |
| `authorizedParties` | — | No | Accepted `azp` values (your app origins). |
| `timeoutMs` | — | No | Per-attempt timeout. Default `10_000`. |
| `retries` | — | No | Extra attempts for **GET** only. Default `2`. |
| `jwksMaxAgeMs` | — | No | JWKS document lifetime. Default `600_000`. |
| `jwksCooldownMs` | — | No | Minimum gap between unknown-`kid` refreshes. Default `30_000`. |

What you get back:

```ts
orbit.client          // typed Backend API client (users, organizations, sessions, webhooks, …)
orbit.verifyToken(jwt) // SessionClaims, or throws OrbitIdError
orbit.authenticate(req) // AuthContext | null  (Node IncomingMessage or Fetch Request)
orbit.webhooks.verify(rawBody, headers)
orbit.m2m.verify(token)
orbit.apiKeys.verify(key)
orbit.config          // { apiUrl, jwksUrl, issuer, audience, clockToleranceSeconds }
orbit.version
```

## Sessions

Tokens are read from `Authorization: Bearer` first, then the `__session` cookie. A token is rejected
when it uses an algorithm other than RS256/ES256/ES384/ES512/EdDSA, comes from another issuer,
names an unknown `kid`, is expired, or is not valid yet.

```ts
const auth = await orbit.authenticate(req);
if (!auth) return res.status(401).end();
auth.userId; auth.sessionId; auth.orgId; auth.orgRole; auth.orgPermissions;
auth.has({ permission: "org:sys_memberships:manage" });
```

`authenticate()` returns `null` for anything that means "not signed in". It throws only when
verification could not run at all (for example the JWKS endpoint is unreachable), so the adapters can
answer `503` instead of a misleading `401`.

JWKS keys are cached. An unknown `kid` triggers one re-fetch (key rotation); further unknown `kid`s
inside the cooldown are answered from the cache, so a flood of bad tokens cannot hammer the server.
When a refresh fails, previously cached keys keep working.

## Express

```ts
import express from "express";
import { createOrbitId } from "@orbitid/node";

const orbit = createOrbitId();
const app = express();

app.get("/me", orbit.requireAuth(), (req, res) => res.json({ userId: req.auth!.userId }));

app.get("/members", orbit.requirePermission("org:sys_memberships:manage"), (req, res) => {
  res.json({ orgId: req.auth!.orgId });
});

// Optional auth: req.auth is the caller or null.
app.get("/", orbit.expressMiddleware(), (req, res) => res.json({ signedIn: !!req.auth }));

// Webhooks need the raw body.
app.post("/api/webhooks", express.raw({ type: "application/json" }), orbit.webhookHandler(async (event) => {
  if (event.type === "user.created") await onUserCreated(event.data);
}));

app.listen(3000);
```

Refusals are `{ errors: [{ code, message }] }` — the same shape the OrbitID server uses — with
`401` + `www-authenticate` when signed out and `403` when a permission or role is missing.

`getAuth(req)` reads what an adapter attached; `getAuth(req, orbit)` verifies on demand, for handlers
you wire by hand on `node:http`.

## Fastify

```ts
import Fastify from "fastify";
import { createOrbitId } from "@orbitid/node";

const orbit = createOrbitId();
const app = Fastify();

await app.register(orbit.fastifyPlugin());      // decorates request.auth (null by default)
app.get("/me", { preHandler: orbit.fastifyRequireAuth() }, (request) => request.auth);
app.get("/admin", { preHandler: orbit.fastifyRequirePermission("org:sys_memberships:manage") }, handler);

await app.listen({ port: 3000 });
```

The plugin is written against a structural type, so it compiles against Fastify's own types and
needs no Fastify dependency.

## Hono

```ts
import { Hono } from "hono";
import { createOrbitId, type OrbitIdHonoVariables } from "@orbitid/node";

const orbit = createOrbitId();
const app = new Hono<{ Variables: OrbitIdHonoVariables }>();

app.use("*", orbit.honoMiddleware());                       // c.get("auth"): AuthContext | null
app.get("/me", orbit.honoRequireAuth(), (c) => c.json({ userId: c.get("auth")!.userId }));
app.get("/admin", orbit.honoRequirePermission("org:sys_memberships:manage"), handler);

export default app;
```

Also on a plain `node:http` server:

```ts
import { createServer } from "node:http";

createServer(async (req, res) => {
  const auth = await orbit.authenticate(req);
  if (!auth) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ errors: [{ code: "authentication_invalid", message: "Authentication required" }] }));
    return;
  }
  res.end(JSON.stringify({ userId: auth.userId }));
}).listen(3001);
```

## Webhooks

```ts
app.post("/api/webhooks", express.raw({ type: "application/json" }), orbit.webhookHandler(async (event) => {
  // event.type is a known OrbitID event name; event.data is the resource
}));
```

Verification uses `svix-id`, `svix-timestamp` and `svix-signature` against a 5-minute tolerance, so
an old delivery replayed later fails. Pass the **raw** bytes: a parsed body cannot be verified.

```ts
const event = await orbit.webhooks.verify(rawBody, req.headers);
```

## Machines and API keys

```ts
const machine = await orbit.m2m.verify(bearerToken); // { valid, machineId, machine, scopes… }
const key = await orbit.apiKeys.verify(keyFromHeader); // { id, subject, scopes, revoked, … }
```

Both call the server (`POST /v1/m2m/tokens/verify`, `POST /v1/api_keys/verify`) with the secret key,
so a revoked token or key is refused immediately.

## Errors

Every failure is an `OrbitIdError`:

```ts
import { OrbitIdError, isOrbitIdError } from "@orbitid/node";

try {
  await orbit.client.users.getUser("user_1");
} catch (error) {
  if (isOrbitIdError(error)) {
    error.status;   // HTTP status, or null when the request never reached the server
    error.code;     // API error code, e.g. "resource_not_found"
    error.traceId;  // trace_id from the server, for support
    error.reason;   // why the SDK refused: "token-expired", "network-error", …
  }
}
```

Only idempotent `GET`s are retried (network failure, timeout, `429`, `5xx`), with exponential backoff
and `Retry-After` honoured. A `POST` is never repeated, so a create is never applied twice. Every
request carries `User-Agent: orbitid-node/<version>`.

## Documentation

Longer material — the full configuration reference, the token verification rules and adapter
semantics — is in [docs/NODE_SDK.md](../../docs/NODE_SDK.md). A runnable example lives in
[`apps/example-node`](../../apps/example-node).
