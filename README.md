<img src="assets/icon.svg" width="64" height="64" alt="">

# OrbitID

Open-source authentication and user management that runs on your own Postgres. One server, an admin dashboard, and SDKs for the browser, React, Next.js and backends. Sign-in, sessions, organizations, roles, API keys and webhooks are included. There is no hosted service and nothing is billed. User data stays in your database. Outbound calls go to integrations you turn on, such as email, social sign-in or the breached-password check, plus a release check to GitHub every 6 hours that sends no instance data and is off with `ORBITID_UPDATE_CHECK=false`.

You write `useUser`, `useAuth`, `<SignIn />`, `<UserButton />`, `auth()` and `has({ permission })` in your app, and the data lands in a database you control.

**Everything is free.** Every feature in this repository — social and custom OAuth/OIDC sign-in, enterprise SAML/OIDC SSO, organizations, webhooks and the dashboard — is available to every self-hosted instance. There are no plans, license keys, seat limits or paid tiers.

## What's in the box

| Package | What it is |
|---|---|
| [`crates/`](crates/README.md) | Rust auth server (binary `orbitid`) on Postgres: Frontend API, Backend API, OIDC provider, SAML, JWKS. Serves the dashboard |
| [`@orbitid/js`](packages/js) | Browser SDK (`OrbitID` class): resources, state, token refresh, cookies |
| [`@orbitid/react`](packages/react) | Provider, hooks, control components and the prebuilt UI (shadcn/ui) |
| [`@orbitid/nextjs`](packages/nextjs) | Next.js App Router integration: middleware, `auth()`, `currentUser()` |
| [`@orbitid/backend`](packages/backend) | Server SDK: typed Backend API client, `verifyToken`, `authenticateRequest`, webhook verification |
| [`@orbitid/node`](packages/node) | Node.js SDK: Express, Fastify, Hono and plain `http` adapters, token verification with a cached key set, webhook and machine-token helpers |
| [`@orbitid/ui`](packages/ui) | shadcn/ui primitives and Tailwind v4 tokens |
| [`@orbitid/dashboard`](apps/dashboard) | Admin dashboard (Vite + React + shadcn) |
| [`example-next`](apps/example-next) | Next.js demo app using all of the above |
| [`example-node`](apps/example-node) | Plain Node server using `@orbitid/node` |
| [`playground`](playground) | Test site that fills itself in from your running instance. Not shipped |

## Feature coverage

| Area | Status |
|---|---|
| Email + password, username, phone identifiers | ✅ |
| Email code, magic link ("email link"), SMS code | ✅ Email through Resend or SMTP; SMS via Twilio or an HTTPS webhook; no console/file fallback |
| Social OAuth (Google, GitHub, GitLab, Discord, Microsoft, Apple, Facebook, X, LinkedIn, Slack, Twitch, Spotify, Zoom, …) + custom OIDC and OAuth 2.0 providers | ✅ |
| Passkeys (WebAuthn) | ✅ tested end to end with a software authenticator |
| MFA: TOTP authenticator, backup codes, SMS, email code, trusted devices | ✅ |
| Anonymous (guest) accounts that upgrade in place | ✅ |
| Password policy, HIBP breach check, lockout, rate limiting, CAPTCHA (Turnstile / hCaptcha) | ✅ |
| Multi-session and session reverification | ✅; operator impersonation and sign-in-token minting are refused |
| User profile: emails, phones, connected accounts, password, devices, delete account | ✅ |
| Organizations: roles, invitations, verified domains, membership requests, suggestions; instance-wide custom roles also work without organizations | ✅ |
| Allowlist, blocklist, waitlist, invitations, restricted sign-up | ✅ |
| JWT templates with shortcodes and custom signing keys | ✅ |
| Webhooks (Svix-compatible signing, retries, delivery log) | ✅ |
| API keys, machine-to-machine tokens | ✅ |
| OIDC / OAuth 2 provider (OrbitID as the identity provider): JWT or opaque access tokens, introspection, revocation, organization claims, device authorization grant | ✅ |
| Enterprise SSO: SAML 2.0 and OIDC connections (tested against a second instance and a signing SAML IdP) | ✅ |
| Move data between Postgres databases (`export`, `import`); migrate off the TypeScript server's SQLite with its last release | ✅ |
| OpenAPI 3.1 description of every route, served at `/v1/openapi.json` and linked from `/docs` | ✅ |
| Admin dashboard, audit logs, stats | ✅ |
| Web3 wallets, Google One Tap, native mobile SDKs | not planned |

## Quick start

With Docker, see [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md): copy `.env.example` to `.env`, set `ORBITID_ENCRYPTION_KEY` and `POSTGRES_PASSWORD`, then `docker compose up -d` starts Postgres and OrbitID, reports the dashboard URL and publishable key, and serves the dashboard at `http://localhost:4000`.

From source (Rust for the server, Bun and Node 20 for the SDKs and dashboard). Postgres is required:

```bash
# Ubuntu/Debian build dependencies for SAML verification:
sudo apt-get install -y clang pkg-config libxml2-dev libxmlsec1-dev libssl-dev
bun install
export ORBITID_DATABASE_URL=postgres://user:password@localhost:5432/orbitid   # required; postgres:// only
export ORBITID_ENCRYPTION_KEY="$(openssl rand -base64 32)"   # required; keep the same value across restarts
cargo run -p orbitid-server -- start   # http://localhost:4000; startup prints no secret key
# In another terminal, explicitly print the keys for this same instance/environment:
cargo run -q -p orbitid-server -- keys
bun run dev:dashboard       # http://localhost:5173, proxies the API; create the owner account on first visit
```

Check it with the playground, a separate test site that reads the instance and builds its own pages (sign-in, account, organizations, API keys, a session inspector, an API lab, webhooks, and seed data):

```bash
cp playground/.env.example playground/.env.local   # paste the keys from the server
bun run --filter orbitid-playground dev            # http://localhost:3300
```

Open the test site at `http://localhost:3300`, not `http://127.0.0.1:3300`: the instance's cross-site session cookie is scoped to `localhost`, so the IP form looks signed out.

In the dashboard, configure **Email & SMS** and send a test before enabling email/phone verification or sign-in. Then use **Authentication** to choose identifiers and strategies, **Organizations** to turn organizations on, and **Social connections** to add provider credentials. Missing required fields or provider configuration are refused by the server. **Roles & permissions** supports instance roles even when organizations are off.

## Use it in Next.js

```tsx
// app/layout.tsx
import { OrbitIDProvider } from "@orbitid/nextjs/server";
import "./globals.css"; // imports tailwindcss and "@orbitid/ui/styles.css"

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <OrbitIDProvider>{children}</OrbitIDProvider>
      </body>
    </html>
  );
}
```

```tsx
// any client component
import { SignedIn, SignedOut, SignIn, UserButton, OrganizationSwitcher } from "@orbitid/nextjs";

<SignedIn>
  <OrganizationSwitcher />
  <UserButton />
</SignedIn>
<SignedOut>
  <SignIn routing="path" path="/sign-in" />
</SignedOut>
```

```ts
// middleware.ts
import { orbitIdMiddleware, createRouteMatcher } from "@orbitid/nextjs/server";

const isProtected = createRouteMatcher(["/dashboard(.*)"]);

export default orbitIdMiddleware(async (auth, req) => {
  if (isProtected(req)) await auth.protect();
});

export const config = { matcher: ["/((?!_next|.*\\.(?:svg|png|jpe?g|gif|ico|webp|woff2?|css|js|map|txt|xml)$).*)"] };
```

```ts
// any server component, route handler or action
import { auth, currentUser } from "@orbitid/nextjs/server";

const { userId, orgId, has } = await auth();
if (!has({ permission: "org:sys_memberships:manage" })) throw new Error("forbidden");
const user = await currentUser();
```

## Use it from Node.js

```ts
import express from "express";
import { createOrbitId } from "@orbitid/node";

const orbit = createOrbitId(); // reads ORBITID_SECRET_KEY and ORBITID_API_URL
const app = express();
app.use(orbit.expressMiddleware());
app.get("/me", orbit.requireAuth(), (req, res) => res.json({ userId: req.auth!.userId }));
```

Fastify, Hono and plain `http` adapters, webhooks and machine tokens are in [packages/node](packages/node/README.md).

## Use it from any backend

```ts
import { createOrbitIdClient, verifyToken } from "@orbitid/backend";

const orbit = createOrbitIdClient({ secretKey: process.env.ORBITID_SECRET_KEY!, apiUrl: "http://localhost:4000" });
const { data: users } = await orbit.users.getUserList({ query: "ada", limit: 10 });

const claims = await verifyToken(jwt, { jwksUrl: "http://localhost:4000/.well-known/jwks.json" });
```

Webhooks are signed Svix-style; verify them with `verifyWebhook` from `@orbitid/backend/webhooks`.

## How it works

A **client** (browser) holds an httpOnly `__client` cookie; it owns **sessions**; the SDK mints a 60-second RS256 **session JWT** from the Frontend API and refreshes it before expiry. Your backend verifies that JWT offline against `/.well-known/jwks.json`. A session has no expiry by default: it stays signed in until the user signs out, an operator revokes it or bans the user, and transient refresh failures never sign anybody out (see [docs/SECURITY.md](docs/SECURITY.md#8-session-persistence)). The Backend API (secret key) manages users, organizations, sessions and settings. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full API contract.

## Configuration

Environment variables are split by where they go: **SERVER** (the machine running OrbitID), **WEBSITE · BACKEND** (secret, your app's server) and **WEBSITE · BROWSER** (public, compiled into client code). [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md) lists every variable under its label, and the dashboard's **Connect your app** page prints copy-ready blocks for your instance. Server variables are also in [`.env.example`](.env.example). Everything else (identifiers, password policy, social providers, MFA, sessions, organizations, email/SMS, branding) is instance settings, editable in the dashboard or through `PATCH /v1/instance`. Set `ORBITID_ENCRYPTION_KEY` to a long random value before storing real data.

## Scaling and upgrading

The server is stateless: run several replicas behind a load balancer against one Postgres database. Settings,
sessions, rate-limit windows and uploaded images live in Postgres, and settings changes propagate over
`LISTEN/NOTIFY`. Set `ORBITID_TRUST_PROXY=1` behind one proxy, and use `/ready` for readiness probes
(`/health` is liveness; the container image and compose file use `orbitid healthcheck`).
[`docker-compose.scale.yml`](docker-compose.scale.yml) is a runnable three-replica example.

A Postgres database created by the TypeScript server is adopted in place by the Rust binary. A SQLite or PGlite
instance must first run the **last TypeScript release's** `orbitid copy --from sqlite:… --to postgres://…`, then
switch `ORBITID_DATABASE_URL`. See [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md#upgrading) and
[docs/DATA_MOVE.md](docs/DATA_MOVE.md).

Migrations run on boot under an advisory lock, before the server listens, so pulling a new image and
restarting is the whole upgrade. The dashboard shows **Update available** when a newer release is out.
Unattended updates are opt-in: pin an image tag and let a timer or Watchtower pull it
([docs/SELF_HOSTING.md](docs/SELF_HOSTING.md#automatic-updates-opt-in)).

## Development

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features   # needs Postgres (ORBITID_TEST_PG_ADMIN_URL)
bun run typecheck   # every TypeScript workspace
bun run test        # every TypeScript workspace (vitest)
bun run test:maintenance # repository guard tests (Node)
bun run check:files  # maintained text: at most 500 lines and 32 KiB per file
bun run check:docs   # local Markdown link targets
```

Maintained code, tests, scripts and Markdown must stay within both file-size limits. Split by responsibility;
do not compress code to satisfy the check. Generated OpenAPI JSON, the historical drizzle SQL fixtures used by
the migration tests, build output, lockfiles and binary assets keep their required formats and are exempt. Keep public entry points stable
when extracting modules. Run the affected package tests and typechecks after refactoring, the Rust workspace
tests after server changes (`cargo test --workspace`), and update `docs/openapi.json` by hand when the API
changes — it is the source of truth the Rust server embeds and serves.

## Documentation

| Topic | Where |
|---|---|
| Run it yourself | [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md), [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md), [docs/DATA_MOVE.md](docs/DATA_MOVE.md) |
| HTTP API | [docs/API.md](docs/API.md), `/v1/openapi.json` on your instance, and [docs/openapi.json](docs/openapi.json) |
| Security | [docs/SECURITY.md](docs/SECURITY.md) |
| Sessions and persistence | [docs/SESSIONS.md](docs/SESSIONS.md) |
| Roles and permissions | [docs/RBAC.md](docs/RBAC.md) |
| Email | [docs/EMAIL.md](docs/EMAIL.md) |
| Sign-in features | [docs/AUTH_FEATURES.md](docs/AUTH_FEATURES.md), [docs/PASSKEYS.md](docs/PASSKEYS.md), [docs/HANDSHAKE.md](docs/HANDSHAKE.md) |
| Identity provider and federation | [docs/OIDC.md](docs/OIDC.md), [docs/FEDERATION.md](docs/FEDERATION.md) |
| OIDC client guides | [Tinyauth](docs/integrations/tinyauth.md), [Authentik](docs/integrations/authentik.md), [generic clients](docs/integrations/generic.md) |
| SDKs | [docs/NODE_SDK.md](docs/NODE_SDK.md), [packages/nextjs](packages/nextjs/README.md), [packages/react](packages/react/README.md) |
| Dashboard | [docs/DASHBOARD.md](docs/DASHBOARD.md) |
| Architecture | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |

## Known gaps

- Social sign-in is tested end to end against a second OrbitID instance acting as the identity provider (custom OIDC, enterprise OIDC) and a signing SAML IdP, not against the live Google, GitHub or Apple services. Apple's client secret is generated from your `.p8` key, but Apple's own endpoints were never called.
- Passkeys are tested with a software authenticator against the real API, not with a hardware security key or a platform authenticator in a real browser.
- Tokens delivered by the handshake appear in the API host's access log for one request. See [docs/HANDSHAKE.md](docs/HANDSHAKE.md).
- Cross-site POST callbacks (SAML ACS, Apple `form_post`) need an https base URL: the browser-binding cookie is `SameSite=None; Secure` only over https. This is a browser rule, not something the server can relax.
- The dashboard is opened by accounts with the Owner or Administrator role (the secret key does not open it), but Backend API changes made from the console are still audited with a generic operator actor rather than the account ([docs/SECURITY.md](docs/SECURITY.md)).
- Uploaded images from the TypeScript server lived on disk and are not migrated into Postgres automatically; re-upload them after the switch ([docs/DATA_MOVE.md](docs/DATA_MOVE.md)).

## License

MIT
