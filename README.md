<img src="assets/icon.svg" width="64" height="64" alt="">

# OrbitID

Open-source, self-hostable authentication and user management. A Clerk-shaped platform you run yourself: an auth server, a browser SDK, React components built on [shadcn/ui](https://ui.shadcn.com), Next.js and backend SDKs, and an admin dashboard.

If you know Clerk, you already know OrbitID: `useUser`, `useAuth`, `<SignIn />`, `<UserButton />`, `auth()`, `has({ permission })`, publishable and secret keys, JWT templates, webhooks.

## What's in the box

| Package | What it is |
|---|---|
| [`@orbitid/server`](packages/server) | Hono + SQLite (Drizzle) auth server: Frontend API, Backend API, OIDC provider, SAML, JWKS |
| [`@orbitid/js`](packages/js) | Browser SDK (`OrbitID` class): resources, state, token refresh, cookies |
| [`@orbitid/react`](packages/react) | Provider, hooks, control components and the prebuilt UI (shadcn/ui) |
| [`@orbitid/nextjs`](packages/nextjs) | Next.js App Router integration: middleware, `auth()`, `currentUser()` |
| [`@orbitid/backend`](packages/backend) | Server SDK: typed Backend API client, `verifyToken`, `authenticateRequest`, webhook verification |
| [`@orbitid/ui`](packages/ui) | shadcn/ui primitives and Tailwind v4 tokens |
| [`@orbitid/dashboard`](apps/dashboard) | Admin dashboard (Vite + React + shadcn) |
| [`example-next`](apps/example-next) | Next.js demo app using all of the above |

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
| Billing / subscriptions, Web3 wallets, Google One Tap, native mobile SDKs, hosted account portal | ❌ not implemented |

## Quick start

Requirements: [Bun](https://bun.sh) for installing and scripts, Node 20+ to run the server (the SQLite driver is a native Node addon).

```bash
bun install
bun run dev:server          # http://localhost:4000, prints your publishable + secret keys
bun run dev:dashboard       # http://localhost:5173, sign in with the secret key
```

Run the example app:

```bash
cp apps/example-next/.env.example apps/example-next/.env.local   # paste the keys from the server
bun run dev:example         # http://localhost:3000
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

export const config = { matcher: ["/((?!_next|.*\\..*).*)"] };
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

Same model as Clerk: a **client** (browser) holds an httpOnly `__client` cookie; it owns **sessions**; the SDK mints a 60-second RS256 **session JWT** from the Frontend API and refreshes it before expiry. Your backend verifies that JWT offline against `/.well-known/jwks.json`. The Backend API (secret key) manages users, organizations, sessions and settings. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full API contract.

## Configuration

Server environment variables are listed in [`packages/server/.env.example`](packages/server/.env.example). Everything else (identifiers, password policy, social providers, MFA, sessions, organizations, email/SMS, branding) is instance settings, editable in the dashboard or through `PATCH /v1/instance`. Set `ORBITID_ENCRYPTION_KEY` to a long random value before storing real data.

## Development

```bash
bun run typecheck   # every workspace
bun run test        # every workspace (vitest)
```

## Known gaps

- Passkey registration and authentication are covered by option-generation and mocked-browser tests, not against a real authenticator.
- Social providers are exercised through a stubbed adapter, not live identity providers. Apple needs a pre-generated client-secret JWT.
- SQLite only. The schema is Drizzle, so a Postgres dialect is a contained change.
- There is no Clerk-style handshake: an expired session JWT with a live client reads as signed-out until the browser SDK refreshes it.
- The OIDC provider issues opaque access tokens only, and its `id_token` carries no organization claims yet.
- The auth components keep a second English dictionary (`components/auth/_shared/strings.ts`) as a fallback next to the provider's `enUS`; they should share one.

## License

MIT
