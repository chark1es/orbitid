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
| [`@orbitid/ui`](packages/ui) | shadcn/ui primitives and Tailwind v4 tokens |
| [`@orbitid/dashboard`](apps/dashboard) | Admin dashboard (Vite + React + shadcn) |
| [`example-next`](apps/example-next) | Next.js demo app using all of the above |
| [`playground`](playground) | Test site that fills itself in from your running instance. Not shipped |

## Feature coverage

| Area | Status |
|---|---|
| Email + password, username, phone identifiers | ✅ |
| Email code, magic link ("email link"), SMS code | ✅ (SMS via Twilio, webhook, or console) |
| Social OAuth (Google, GitHub, GitLab, Discord, Microsoft, Apple, Facebook, X, LinkedIn, Slack, Twitch, Spotify, …) + custom OIDC providers | ✅ |
| Passkeys (WebAuthn) | ✅ implemented, see known gaps |
| MFA: TOTP authenticator, backup codes, SMS | ✅ |
| Password policy, HIBP breach check, lockout, rate limiting, CAPTCHA (Turnstile / hCaptcha) | ✅ |
| Multi-session, session reverification, impersonation (actor tokens), sign-in tokens | ✅ |
| User profile: emails, phones, connected accounts, password, devices, delete account | ✅ |
| Organizations: roles, custom roles and permissions, invitations, verified domains, membership requests, suggestions | ✅ |
| Allowlist, blocklist, waitlist, invitations, restricted sign-up | ✅ |
| JWT templates with shortcodes and custom signing keys | ✅ |
| Webhooks (Svix-compatible signing, retries, delivery log) | ✅ |
| API keys, machine-to-machine tokens | ✅ |
| OIDC / OAuth 2 provider (OrbitID as the identity provider) | ✅ |
| Enterprise SSO: SAML 2.0 and OIDC connections | ✅ |
| Admin dashboard, audit logs, stats | ✅ |
| Web3 wallets, Google One Tap, native mobile SDKs | not planned |

## Quick start

With Docker, see [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md): `docker compose up -d` starts Postgres and OrbitID, prints your keys, and serves the dashboard at `http://localhost:4000`.

From source (Bun for installing and scripts, Node 20 to run the server because the SQLite driver is a native addon):

```bash
bun install
export ORBITID_DATABASE_URL=postgres://user:password@localhost:5432/orbitid   # omit to use a local SQLite file
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

Infrastructure settings (URL, database, encryption key) are environment variables, listed in [`.env.example`](.env.example). Everything else (identifiers, password policy, social providers, MFA, sessions, organizations, email/SMS, branding) is instance settings, editable in the dashboard or through `PATCH /v1/instance`. Set `ORBITID_ENCRYPTION_KEY` to a long random value before storing real data.

## Development

```bash
bun run typecheck   # every workspace
bun run test        # every workspace (vitest)
```

## Known gaps

- Passkey registration and authentication are covered by option-generation and mocked-browser tests, not against a real authenticator.
- Social providers are exercised through a stubbed adapter, not live identity providers. Apple needs a pre-generated client-secret JWT.
- Docker packaging is written but was not run in the environment this was built in. Postgres and SQLite are both covered by the server test suite; the Postgres run uses a real embedded Postgres.
- There is no server-side handshake: a request with an expired session JWT and a live client reads as signed out until the browser SDK refreshes it, so a hard navigation to a protected route after an idle period lands on sign-in. `<SignIn />` sends an already-signed-in visitor straight on to `redirect_url`.
- The OIDC provider issues opaque access tokens only, and its `id_token` carries no organization claims yet.
- With `mfa.required`, a user who has no second factor yet gets a *pending* session that can only enrol one (`session_pending` elsewhere), and both SDKs report it as signed out. `<SignIn />` renders a set-up-two-factor step for it.
- Cross-site POST callbacks (SAML ACS, Apple `form_post`) need an https base URL: the browser-binding cookie is `SameSite=None; Secure` only over https.

## License

MIT
