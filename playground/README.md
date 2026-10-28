# OrbitID test site

A test console for a running OrbitID instance. It reads the instance's public environment from the publishable key and renders what that instance supports: sign-in and sign-up, account, organizations, API keys, waitlist, a session inspector, route protection, webhooks, and seed data.

This site is not for production. It exposes the Backend API actions it is configured for and stores webhook events in dev server memory.

## Start

Run these from the repository root.

```bash
# 1. Start the server. It prints a publishable key and a secret key once.
bun run --filter @orbitid/server start

# 2. Create the environment file.
cp playground/.env.example playground/.env.local

# 3. Paste the printed keys into playground/.env.local, then start the test site.
bun run --filter orbitid-playground dev
```

Open http://localhost:3300.

The publishable key carries the Frontend API URL, so `ORBITID_API_URL` is optional. When the key is missing or the server does not answer, the Setup page shows the variables to set and the commands above.

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_ORBITID_PUBLISHABLE_KEY` | yes | Frontend API key. Its decoded host is the instance URL. |
| `ORBITID_SECRET_KEY` | no | Backend API key. Unlocks seed data, webhook endpoint registration and deliveries, and session settings in the matrix. |
| `ORBITID_API_URL` | no | Overrides the API host decoded from the key. |
| `ORBITID_WEBHOOK_SECRET` | no | Endpoint secret used by the webhook receiver. Without it, register the receiver on the Webhooks page or paste the secret there. |
| `NEXT_PUBLIC_ORBITID_SIGN_IN_URL` | no | Defaults to `/sign-in`. |
| `NEXT_PUBLIC_ORBITID_SIGN_UP_URL` | no | Defaults to `/sign-up`. |

`playground/.env.local` is gitignored. The test site never writes keys to disk.

`NEXT_PUBLIC_*` values are inlined when you run `next build`. Set them before the build, or use the dev server, which reads the file at startup.

## Pages

| Page | What it exercises |
| --- | --- |
| `/` | Connection state and a feature matrix built from `GET /v1/client/environment`. Social providers start a real sign-in. |
| `/sign-in`, `/sign-up` | Prebuilt `SignIn` and `SignUp` with path routing. A `__orbit_ticket` query parameter signs in as the ticket's user. |
| `/account` | Prebuilt `UserProfile`: profile, emails, connected accounts, password, passkeys, MFA, sessions. |
| `/organizations` | `OrganizationList`, `OrganizationSwitcher`, `OrganizationProfile` and `CreateOrganization`. |
| `/api-keys` | `APIKeys` for the user and the active organization. |
| `/waitlist` | `Waitlist`. |
| `/inspector` | `useAuth`, `useUser`, `useSession`, the decoded session JWT with a countdown, `getToken({ template })`, a `has()` tester, sessions and an activity board. |
| `/api-lab` | Calls `/api/public`, `/api/whoami` and `/api/admin` with and without a bearer token and shows status, headers and body. |
| `/webhooks` | Svix signature verification, the last 100 received events, endpoint registration, a test event, deliveries. |
| `/seed` | Creates users and an organization through the Backend API, creates sign-in links, lists and deletes the users it made. |

The middleware protects `/account`, `/organizations`, `/api-keys` and `/inspector`. `/`, `/sign-in`, `/sign-up` and the lab pages stay public so a signed-out test is possible.

## Tests and checks

```bash
cd playground
../node_modules/.bin/tsc -p tsconfig.json --noEmit
../node_modules/.bin/next build
../node_modules/.bin/vitest run
```

The unit tests cover the feature matrix builder against an `EnvironmentJSON` fixture, the JWT decoder and countdown, and the `has()` probe helpers.
