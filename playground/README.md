# OrbitID test site

A test console for a running OrbitID instance. It reads the instance's public environment from the publishable key and renders what that instance supports: sign-in and sign-up, account, organizations, API keys, waitlist, a session inspector, route protection, webhooks, and seed data.

This site is not for production. It exposes the Backend API actions it is configured for and stores webhook events in dev server memory.

## Start

Run these from the repository root.

```bash
# 1. Start the server. It prints the public URL and publishable key, never the secret key.
bun run --filter @orbitid/server start

# 2. Create the environment file.
cp playground/.env.example playground/.env.local

# 3. In another terminal, retrieve the keys explicitly for the same instance/environment.
bun run --filter @orbitid/server start keys
# Put the keys in playground/.env.local, then start the test site.
bun run --filter orbitid-playground dev
```

Open http://localhost:3300.

The publishable key carries the Frontend API URL, so `ORBITID_API_URL` is optional. When the key is missing or the server does not answer, the Setup page shows the variables to set and the commands above.

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_ORBITID_PUBLISHABLE_KEY` | yes | Frontend API key. Its decoded host is the instance URL. |
| `ORBITID_SECRET_KEY` | no | Backend API key. Unlocks seed data, webhook endpoint registration and deliveries, session and provider settings in the matrix, and the OAuth application used by the device flow. |
| `ORBITID_API_URL` | no | Overrides the API host decoded from the key. |
| `ORBITID_WEBHOOK_SECRET` | no | Endpoint secret used by the webhook receiver. Without it, register the receiver on the Webhooks page or paste the secret there. |
| `NEXT_PUBLIC_ORBITID_SIGN_IN_URL` | no | Defaults to `/sign-in`. |
| `NEXT_PUBLIC_ORBITID_SIGN_UP_URL` | no | Defaults to `/sign-up`. |

`playground/.env.local` is gitignored. The test site never writes keys to disk.

`NEXT_PUBLIC_*` values are inlined when you run `next build`. Set them before the build, or use the dev server, which reads the file at startup.

## Pages

| Page | What it exercises |
| --- | --- |
| `/` | Connection state and a feature matrix built from `GET /v1/client/environment`, plus mail, OIDC provider, trusted-device, guest and handshake rows read with the secret key. Social providers start a real sign-in. |
| `/sign-in`, `/sign-up` | Prebuilt `SignIn` and `SignUp` with path routing. Operator-minted sign-in links are not supported. |
| `/guest` | `signUp.createAnonymous()` makes a guest session, `useUser().isAnonymous` and the `anonymous` claim are read back, and the same account is upgraded in place by verifying an email address. |
| `/device` | Device authorization grant (RFC 8628): registers or picks an OAuth application through the Backend API, starts `POST /oauth/device_authorization` from the server, shows the code and link, and polls the token endpoint. |
| `/account` | Prebuilt `UserProfile`: profile, emails, connected accounts, password, passkeys, MFA, sessions and trusted devices. |
| `/organizations` | `OrganizationList`, `OrganizationSwitcher`, `OrganizationProfile` and `CreateOrganization`. |
| `/api-keys` | `APIKeys` for the user and the active organization. |
| `/waitlist` | `Waitlist`. |
| `/inspector` | `useAuth`, `useUser`, `useSession`, the decoded session JWT with a countdown, `getToken({ template })`, a `has()` tester, sessions, trusted devices and an activity board. Sessions that skipped their second factor on a trusted device are marked. |
| `/api-lab` | Calls `/api/public`, `/api/whoami` and `/api/admin` with and without a bearer token, plus `/api/handshake`, `/api/device` (discovery, probe, start) and `/api/email-test`. Shows status, headers and body. |
| `/webhooks` | Svix signature verification, the last 100 received events, endpoint registration, a test event, deliveries. |
| `/seed` | Creates users and an organization through the Backend API, then lists and deletes the users it made. Seeded users must complete a normal sign-in. |

The middleware protects `/account`, `/organizations`, `/api-keys` and `/inspector`. `/`, `/sign-in`, `/sign-up`, `/guest`, `/device` and the lab pages stay public so a signed-out test is possible.

Organization widgets and routes remain locked while organizations are disabled. User API keys stay available
without an organization. Light/dark mode applies to both the site shell and embedded authentication widgets.

## Tests and checks

```bash
cd playground
../node_modules/.bin/tsc -p tsconfig.json --noEmit
../node_modules/.bin/next build
../node_modules/.bin/vitest run
```

The unit tests cover the feature matrix builder against an `EnvironmentJSON` fixture, the mail transport resolution, the device-flow response and poll parsing, the raw session skip marker, the JWT decoder and countdown, and the `has()` probe helpers.

## Local only

The playground holds your secret key and calls Backend API helpers (seed data, webhook registration, email test), so it is meant to run on your own machine. `bun run dev` and `bun run start` bind to `127.0.0.1`, which is the real boundary: nothing on your network can reach it. As a second guard it answers only when the request's `Host` header is `localhost`, `127.0.0.1` or `[::1]`; that header is client-controlled, so it protects against mistakes (a reverse proxy, a changed bind address), not against someone who can already reach the port. To expose it anyway, change the bind address yourself and set `ORBITID_PLAYGROUND_ALLOW_REMOTE=true` (WEBSITE · BACKEND), and only on a network you trust.
