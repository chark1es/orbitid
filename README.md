<img src="assets/icon.svg" width="64" height="64" alt="">

# OrbitID

Open-source authentication and user management that runs on your own Postgres. One server, an admin dashboard, and SDKs for the browser, React, Next.js and backends. Sign-in, sessions, organizations, roles, API keys and webhooks are included. There is no hosted service and nothing is billed. User data stays in your database; the only outbound calls are to integrations you turn on, such as email, social sign-in or the breached-password check.

You write `useUser`, `useAuth`, `<SignIn />`, `<UserButton />`, `auth()` and `has({ permission })` in your app, and the data lands in a database you control.

## What's in the box

| Package | What it is |
|---|---|
| [`@orbitid/server`](packages/server) | Hono + Drizzle auth server on Postgres (main) or SQLite: Frontend API, Backend API, OIDC provider, SAML, JWKS. Serves the dashboard |
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
| Email code, magic link ("email link"), SMS code | ✅ Email through Resend or SMTP; SMS via Twilio, webhook, or console |
| Social OAuth (Google, GitHub, GitLab, Discord, Microsoft, Apple, Facebook, X, LinkedIn, Slack, Twitch, Spotify, …) + custom OIDC providers | ✅ |
| Passkeys (WebAuthn) | ✅ tested end to end with a software authenticator |
| MFA: TOTP authenticator, backup codes, SMS, email code, trusted devices | ✅ |
| Anonymous (guest) accounts that upgrade in place | ✅ |
| Password policy, HIBP breach check, lockout, rate limiting, CAPTCHA (Turnstile / hCaptcha) | ✅ |
| Multi-session, session reverification, impersonation (actor tokens), sign-in tokens | ✅ |
| User profile: emails, phones, connected accounts, password, devices, delete account | ✅ |
| Organizations: roles, custom roles and permissions, invitations, verified domains, membership requests, suggestions | ✅ |
| Allowlist, blocklist, waitlist, invitations, restricted sign-up | ✅ |
| JWT templates with shortcodes and custom signing keys | ✅ |
| Webhooks (Svix-compatible signing, retries, delivery log) | ✅ |
| API keys, machine-to-machine tokens | ✅ |
| OIDC / OAuth 2 provider (OrbitID as the identity provider): JWT or opaque access tokens, introspection, revocation, organization claims, device authorization grant | ✅ |
| Enterprise SSO: SAML 2.0 and OIDC connections (tested against a second instance and a signing SAML IdP) | ✅ |
| Move data between SQLite and Postgres (`export`, `import`, `copy`) | ✅ |
| OpenAPI 3.1 description of every route, served at `/docs` | ✅ |
| Admin dashboard, audit logs, stats | ✅ |
| Web3 wallets, Google One Tap, native mobile SDKs | not planned |

## Quick start

With Docker, see [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md): `docker compose up -d` starts Postgres and OrbitID, prints your keys, and serves the dashboard at `http://localhost:4000`.

From source (Bun for installing and scripts, Node 20 to run the server because the SQLite driver is a native addon):

```bash
bun install
export ORBITID_DATABASE_URL=postgres://user:password@localhost:5432/orbitid   # omit to use a local SQLite file
export ORBITID_ENCRYPTION_KEY="$(openssl rand -base64 32)"   # required with Postgres; keep the same value across restarts
bun run dev:server          # http://localhost:4000, prints your publishable and secret keys
bun run dev:dashboard       # http://localhost:5173, sign in with the secret key
```

Check it with the playground, a separate test site that reads the instance and builds its own pages (sign-in, account, organizations, API keys, a session inspector, an API lab, webhooks, and seed data):

```bash
cp playground/.env.example playground/.env.local   # paste the keys from the server
bun run --filter orbitid-playground dev            # http://localhost:3300
```

In the dashboard, open **Authentication** to choose identifiers and strategies, **Organizations** to turn organizations on, and **Social connections** to add provider credentials.

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

A **client** (browser) holds an httpOnly `__client` cookie; it owns **sessions**; the SDK mints a 60-second RS256 **session JWT** from the Frontend API and refreshes it before expiry. Your backend verifies that JWT offline against `/.well-known/jwks.json`. The Backend API (secret key) manages users, organizations, sessions and settings. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full API contract.

## Configuration

Environment variables are split by where they go: **SERVER** (the machine running OrbitID), **WEBSITE · BACKEND** (secret, your app's server) and **WEBSITE · BROWSER** (public, compiled into client code). [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md) lists every variable under its label, and the dashboard's **Connect your app** page prints copy-ready blocks for your instance. Server variables are also in [`.env.example`](.env.example). Everything else (identifiers, password policy, social providers, MFA, sessions, organizations, email/SMS, branding) is instance settings, editable in the dashboard or through `PATCH /v1/instance`. Set `ORBITID_ENCRYPTION_KEY` to a long random value before storing real data.

## Development

```bash
bun run typecheck   # every workspace
bun run test        # every workspace (vitest)
```

## Documentation

| Topic | Where |
|---|---|
| Run it yourself | [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md), [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md), [docs/DATA_MOVE.md](docs/DATA_MOVE.md) |
| HTTP API | [docs/API.md](docs/API.md), the live reference at `/docs`, and [docs/openapi.json](docs/openapi.json) |
| Security | [docs/SECURITY.md](docs/SECURITY.md) |
| Email | [docs/EMAIL.md](docs/EMAIL.md) |
| Sign-in features | [docs/AUTH_FEATURES.md](docs/AUTH_FEATURES.md), [docs/PASSKEYS.md](docs/PASSKEYS.md), [docs/HANDSHAKE.md](docs/HANDSHAKE.md) |
| Identity provider and federation | [docs/OIDC.md](docs/OIDC.md), [docs/FEDERATION.md](docs/FEDERATION.md) |
| SDKs | [docs/NODE_SDK.md](docs/NODE_SDK.md), [packages/nextjs](packages/nextjs/README.md), [packages/react](packages/react/README.md) |
| Dashboard | [docs/DASHBOARD.md](docs/DASHBOARD.md) |
| Architecture | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |

## Known gaps

- The Docker image and compose file are written and reviewed but have not been run: there was no Docker in the environment this was built in. Build and start them once before relying on them.
- Social sign-in is tested end to end against a second OrbitID instance acting as the identity provider (custom OIDC, enterprise OIDC) and a signing SAML IdP, not against the live Google, GitHub or Apple services. Apple's client secret is generated from your `.p8` key, but Apple's own endpoints were never called.
- Passkeys are tested with a software authenticator against the real API, not with a hardware security key or a platform authenticator in a real browser.
- Tokens delivered by the handshake appear in the API host's access log for one request. See [docs/HANDSHAKE.md](docs/HANDSHAKE.md).
- Cross-site POST callbacks (SAML ACS, Apple `form_post`) need an https base URL: the browser-binding cookie is `SameSite=None; Secure` only over https. This is a browser rule, not something the server can relax.
- Switching databases copies data with `export`/`import`; uploaded images are not part of the export and must be copied separately ([docs/DATA_MOVE.md](docs/DATA_MOVE.md)).

## License

MIT
