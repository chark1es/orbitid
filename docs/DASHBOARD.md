# Dashboard

The dashboard is `apps/dashboard`: Vite + React + react-router + TanStack Query over the Backend API, built
from the `@orbitid/ui` primitives and the Timetable design system in [`DESIGN.md`](../DESIGN.md). The
server serves the built files at `/` when `apps/dashboard/dist` exists.

## Sign-in and the console session

### Accounts, owners and administrators

People sign in to the console with their own account on the instance, through the instance's own sign-in form
(the React SDK's `<SignIn/>`, so every enabled method, second factor and passkey works). The secret key does not
open the dashboard: it authenticates servers, SDKs and scripts calling the Backend API (`Authorization: Bearer
sk_…`), nothing else.

- **First run.** While the instance has no real (non-guest) account, so nobody who could open the console, the
  sign-in screen offers **Create the owner account** instead. `POST /v1/operator_sessions/setup` creates that
  account with the seeded **Owner** role (`app:sys_owner`), signs it in on this browser and opens the console in
  one step. Concurrent setups serialize on an advisory lock; exactly one wins. Setup closes once any account exists
  (`403`) and reopens if every account is deleted, including on an instance from before owners. An instance that
  has accounts but no Owner or Administrator never offers setup, so a visitor cannot promote themselves over
  existing users: grant the role from the server with `orbitid owner <email>`. Create the owner before you expose a
  new instance: until then, the first visitor can.
- **Who may enter.** Accounts with the seeded **Owner** (`app:sys_owner`) or **Administrator** (`app:sys_admin`)
  role. Their `app:sys_dashboard:access` permission is reserved: a custom role cannot carry it, and system roles
  cannot be edited or deleted, so only a change to an account's roles changes who may enter. Assign the roles from
  a user's page, under Roles.
- **What visitors see.** Signed out, once an account exists, the instance root (and every console route, which
  sends the visitor to `/login`) is the sign-in form alone, with no other copy around it. A fresh instance with no
  account shows the owner setup form instead. Once an account is signed in on this browser,
  `/login` shows who it is. An account with access gets
  **Open the admin console** (`POST /v1/operator_sessions/from_user`); one without access is told so and can sign
  out. After signing in on that screen, an account with access goes straight into the console. Only this
  browser's own `__client` cookie counts: a session token sent as a bearer (one an application received) or a
  session-id hint cannot open the console.
- **Request-time checks.** A console session is tied to the account session that opened it. Every Backend API
  request re-checks it: removing the role, banning the account or ending its session (signing out anywhere, or
  **Sign out** in the console, which ends both) ends the console at once. A console that fails the check is revoked
  for good, and so are an account's console sessions when an operator removes its access, so giving the role back
  does not revive an old cookie. Console requests count as activity on the account session, so an inactivity
  timeout does not sign out an operator who is working.
- **No owner yet, or owners locked out.** An instance that has accounts but none that can open the console (for
  example accounts from before owners) does not offer setup. Whoever runs
  the server grants the Owner role to an existing account:

  ```sh
  orbitid owner you@example.com   # a verified email address, or a user id (user_…)
  ```

  It adds the role (keeping the account's other roles), emits `user.updated` and audits `instance.owner_granted`.
  An instance with no account at all offers **Create the owner account** on `/login` instead.
  Until some account can open the console, `/login` says so and shows the command to an account signed in
  without access (`console_unclaimed` in the status answer); the signed-out form stays bare. Shell access to the server is the proof of control; there is no
  HTTP equivalent.

`GET /v1/operator_sessions/status` answers all of this in one request (console session, signed-in account and its
access, whether setup is required, whether no account can enter). `index.html` starts it inline, before the app's
code has downloaded, so the first screen is usually the right one with no "checking" frame. If it fails (the server
is unreachable, or the address is rate limited) `/login` says why, with **Try again**.

### The console cookie

Opening the console answers with an httpOnly cookie, `__orbit_operator`, scoped to `Path=/v1`, `SameSite=Strict`
and `Secure` whenever the instance is served over https. The cookie holds an opaque 256-bit token; the server stores
only its sha256 hash. Every Backend API call from the dashboard authenticates with it, and it is only accepted from
the instance's own origin, so another site or another browser origin cannot use it.

- The session lasts 8 hours (`OPERATOR_SESSION_TTL_MS`). The status check confirms it on load, so an expired or
  revoked cookie lands on `/login` without a flash of the shell.
- **Sign out** (`DELETE /v1/operator_sessions/current`) ends the account session and revokes the console row, then
  clears the cookie; replaying the old token is refused. Opening the console again in the same tab revokes the
  previous session.
- Rotating the secret key still ends every console session: each row is bound to a fingerprint of the key.
- Console sessions are audit-logged (`operator_session.created`, `operator_session.revoked`, actor: the account).

The API origin is the server that served the page (`window.__ORBITID__.apiUrl`), falling back to the page's
own origin. A dashboard on a different origin from its API cannot use the cookie; serve the built dashboard from
the server, as a container deployment does.

Sign-out revokes the session on the server before the shell reports success. If revocation fails (the server is
unreachable, or answers `5xx`) the dashboard keeps the session and shows the error, because the cookie is still
live; only a `401` (the session was already gone) counts as a completed sign-out.

### Rate limits

The console routes share the Postgres-backed limiter the rest of the API uses, so a budget holds across replicas.
Each address gets its own budget per route:

| Route | Budget |
| --- | --- |
| `GET /v1/operator_sessions/status`, `GET …/current` | 120 a minute (shared) |
| `POST /v1/operator_sessions/setup` | 10 per 10 minutes (each attempt hashes a password) |
| `POST /v1/operator_sessions/from_user` | 20 a minute |
| `DELETE /v1/operator_sessions/current` | 30 a minute (only sign-outs with nothing to end) |

The account sign-in itself goes through the Frontend API, whose sign-in, sign-up and verification steps have their
own limits. Over budget, a route answers `429 rate_limit_exceeded` with `Retry-After`, and the dashboard says how
long to wait ("Too many attempts. Try again in 30 seconds."). The origin check runs before the counter, so another
site cannot spend a visitor's budget for them. A status check that carries a live console cookie is not charged,
and a sign-out with no cookies at all is a free no-op, so traffic from a shared address cannot sign working
operators out. A sign-out that ends something is never charged; only one that finds nothing to end is. Behind a
reverse proxy, set `ORBITID_TRUST_PROXY`; otherwise every client shares the proxy's
address and one budget. **Settings → User & authentication → Rate limiting** turns every
limit off, these included.

### Developing the dashboard

`bun run dev:dashboard` runs Vite on port 5173. Its `vite.config.ts` proxies `/v1`, `/health`, `/oauth`,
`/.well-known` and `/docs` to `ORBITID_DEV_API_URL` (default `http://localhost:4000`) **and rewrites
`Origin`/`Referer` on the proxied request to that target**. The server therefore sees a genuine same-origin
request and the session cookie behaves exactly as it does in a hosted deployment.

This rewrite lives in the dev-server config, not in the server: production never trusts an arbitrary `localhost`
origin, and a dashboard on another origin must be served behind the same origin as its API (the container image
serves both). Set `ORBITID_DEV_API_URL` to a non-default port only together with a matching `ORBITID_BASE_URL`.

## Pages

| Route | Page | What it does |
|---|---|---|
| `/` | Overview | Instance stats, the sign-up chart and the live activity board. Shows the publishable key and database; secret keys stay out of the dashboard. |
| `/users` | Users | Server-side search, filters, sorting and pagination; bulk actions. |
| `/users/:id` | User detail | Profile, identifiers (read-only: passwords, MFA and identifiers are the user's to change), metadata, sessions, organizations, instance roles, ban/lock, delete. |
| `/organizations`, `/organizations/:id` | Organizations | Members, invitations, domains (including enrollment mode and affiliation-code verification), membership requests and roles. |
| `/sessions` | Sessions | Every session on the instance, with a revoke action. |
| `/invitations`, `/waitlist` | Invitations, Waitlist | Instance-level invitations and the waitlist. |
| `/restrictions` | Restrictions | Allowlist and blocklist entries, sign-up restrictions. |
| `/roles` | Roles & permissions | Instance (`app:`) and organization (`org:`) roles/permissions, kept in separate scopes. |
| `/settings/authentication` | Authentication | Identifiers, password policy, second factors (including email code as a second factor), sign-up mode, guest accounts, captcha and abuse protection. |
| `/settings/social` | Social connections | 26 built-in OAuth presets and custom OIDC / OAuth 2.0 providers: discovery or manual endpoints, claim mapping, PKCE, client-auth method, logo, Test connection, delete. Apple takes a team ID, key ID and `.p8` private key instead of a client secret. |
| `/settings/sessions` | Sessions settings | Opt-in session lifetime and inactivity limits (unlimited by default), token refresh cadence, multi-session mode, trusted devices, custom JWT claims. |
| `/settings/organizations` | Organizations settings | Whether users may create organizations, membership limits, domains, roles. |
| `/settings/email-sms` | Email & SMS | Branding, the mail transport (automatic, Resend, SMTP, or not configured), the from address, code lifetimes, a real test send, and SMS delivery. |
| `/settings/appearance` | Appearance | Logo, colours, theme, hosted page copy. |
| `/jwt-templates` | JWT templates | Template editor with shortcode reference and a live preview. |
| `/connect` | Connect your app | Copy-ready environment blocks for a new application, per framework, plus a setup check. |
| `/api-keys` | API keys | Issue, verify and revoke API keys. |
| `/m2m` | M2M | Machines and machine tokens. |
| `/oauth-apps` | OAuth apps | OrbitID as an OIDC provider: instance provider options (token format, device grant) and per-app endpoints. |
| `/enterprise-sso` | Enterprise SSO | SAML 2.0 and OIDC connections routed by email domain. |
| `/webhooks` | Webhooks | Endpoints, delivery log, retry, test event and signing secret. |
| `/audit-logs` | Audit logs | Every recorded operator and server action. |

The API reference is served by the server at `{apiUrl}/docs`, outside the dashboard.

When the server's release check finds a newer OrbitID release, the top bar shows **Update available** (with
`vX → vY` on wide screens) linking to that release's notes on GitHub. It reads `version` from
`GET /v1/instance`, which the server answers from memory, and shows nothing while the instance is current or
when `ORBITID_UPDATE_CHECK=false`. See [UPDATES.md](UPDATES.md#version-and-update-check).

## Feature availability and user security

Organization management links, user tabs and creation controls stay hidden until organizations are confirmed
enabled. Direct organization pages show a loading or locked state while unavailable. The configuration page
remains reachable, and instance roles stay available regardless of the organization switch.

A domain starts unverified. **Verify** sends a one-time code to an address on that domain through the Backend
API, and the code proves ownership. **Enrollment** is editable per domain: manual invitation, automatic
invitation or automatic suggestion. Changing to automatic invitation can enroll matching members, and a
verified domain is required before automatic enrollment takes effect.

Admin lists that the dashboard shows in full — API keys, machines and tokens, webhook endpoints, OAuth
applications, enterprise connections, JWT templates and the allow/block lists — read every server page instead
of silently stopping at the first 100 rows. API keys also paginate in the browser, so the count and filters
cover the whole set.

On **User detail**, the **Roles** tab assigns `app:` roles directly to the user; the **Organizations** tab assigns
`org:` roles to memberships. Saving instance-role assignments revokes the user's sessions. Existing offline
JWTs can still verify until expiry; see [RBAC.md](RBAC.md).

Identifiers, password status and MFA status are read-only to operators. Credential changes and recovery require
the user-facing authentication/account flow. Operators may still ban, lock, delete, revoke sessions and revoke
trusted devices. The **Trusted devices** tab lists device labels, IPs, activity and expiry with a confirmed revoke
action. Session/activity rows identify second factors skipped by a trusted device. Guest users carry a **Guest**
status and a notice explaining that a guest cannot create organizations or API keys until it becomes a registered
account by adding a verified identifier or a password.

Forms wait for required-field settings before allowing user saves. Server validation enforces the same rules;
removing a required email/phone or saving missing provider credentials is refused even through a direct API call.
The Appearance preview follows the selected theme and allows a temporary Light/Dark flip without saving a draft.

## Theming and SSR

`@orbitid/ui` exports `ThemeProvider`, `useTheme`, `initTheme` and `themeBootstrapScript`. The choice lives in
`localStorage` under `orbitid-theme` (`light`, `dark` or `system`); `system` follows `prefers-color-scheme` live.

- **Client-only apps (the dashboard).** Call `initTheme()` once before `createRoot` (the dashboard does this in
  `main.tsx`) so the class is on `<html>` before the first paint, then render `ThemeProvider`. There is no flash.
- **Server-rendered apps (Next.js, React SSR).** The server cannot read `localStorage` or the visitor's colour
  scheme, so `ThemeProvider` renders a deterministic snapshot on the server and for the hydration render (the
  `defaultTheme`, with `system` resolved to light) and switches to the stored/system preference immediately after
  hydration. That is what prevents the `system:light` → stored-dark hydration mismatch. To avoid a flash of the
  wrong theme before hydration, put the exported bootstrap in `<head>`:

  ```tsx
  import { themeBootstrapScript } from "@orbitid/ui";

  <head>
    <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript() }} />
  </head>
  ```

  Pass the same `storageKey`/`defaultTheme` to the provider and the bootstrap if you customise them. Do not read
  `localStorage` during render in your own components either: use `useTheme()` after hydration.


## Connect your app

`/connect` reads the running instance rather than placeholders:

- the publishable key, from the public `GET /health`;
- the API URL the dashboard is pointed at;
- the live console session (the secret key is a placeholder: the dashboard never holds it);
- the database dialect reported by `/health`.

It then renders, per framework tab (Next.js, React + backend, Node with Express, plain Node script), one
install line and two labelled blocks: **Website · browser (public)** and **Website · backend (secret)**.
Variable names follow the SDKs (`NEXT_PUBLIC_*` for Next.js, `VITE_*` for Vite, `ORBITID_*` for the Node
SDKs). The webhook secret is per endpoint — it comes from the Webhooks page — and is left blank in the
block with a line saying where to find it. `ORBITID_JWT_KEY` is optional and commented out.

The secret key line is a placeholder with a note saying where the real value comes from (`orbitid keys`; startup
logs do not print it), so copying a block can never move a live credential into a chat or a ticket. "Copy
all" pastes both blocks as one file. A read-only **Server (this instance)** block reports the
database, base URL, the email provider in effect and whether private networks are allowed, and points at
`docs/ENVIRONMENT.md`. The encryption key never appears anywhere in the dashboard.

**Check your setup** calls `GET /health` and `GET /v1/client/environment` and reads the saved settings,
then reports each result with a word and a dot (Works, Check, Failed): server reachable, publishable key
present, dashboard session live, a supported database, sign-in methods published, email transport, and
whether the application home URL is an allowed origin. An older server that reports SQLite gets a failed
"Supported database" check with the Postgres migration path instead of a silent warning.

## Secret fields

Every credential in instance settings is write-only. `GET /v1/instance` replaces a stored secret with a
mask (`••••`) and adds a `<field>Set` marker, and `PATCH` drops a mask or an unchanged echo instead of
storing it (`crates/orbitid-core/src/secrets.rs`).

The dashboard mirrors that convention in `pages/_config/settings/`: `secretInputValue` blanks a masked
value so the field starts empty, `secretIsConfigured` reads the mask as "Set", and `buildSettingsPatch`
sends only changed paths and never a masked or empty secret. A `SecretInput` field shows a **Set** chip next
to its label. Leaving it blank keeps the stored value; typing a value replaces it.

This applies to the Resend API key, the SMTP URL, the Twilio auth token, the captcha secret, social client
secrets and the Apple `.p8` key. Enterprise OIDC client secrets are not part of instance settings and are
never returned by the API at all, so the Enterprise SSO page offers an explicit replace field instead.

## Tests

`bun run --filter @orbitid/dashboard test` runs vitest with jsdom and Testing Library. Page tests mock
`fetch` through `pages/_config/__tests__/harness.tsx`, which answers `/v1/instance`, `/health` and
`/v1/client/environment` and records every call so assertions can check the exact PATCH body.
`pages/_config/__tests__/connect.test.ts` covers the snippet builder (variable names per framework, masking,
copy-all) and the setup checks without rendering.

## Load performance

The first screen must not wait on anything it does not show.

- The session check starts inline in `index.html`, in parallel with the bundle download (see above).
- The build writes `.br` and `.gz` next to every text asset; the server sends the smallest one the browser accepts
  (`Vary: Accept-Encoding`). Hashed `/assets/*` are cached for a year.
- React, the router and TanStack Query ship as a separate `framework` chunk that stays cached across upgrades.
- Heavy code loads beside the page instead of before it: recharts (the overview charts, with a fixed-height
  skeleton), zod (the settings normalizer, fetched with `/v1/instance`) and the SDK sign-in form (only for a
  signed-out visitor).
- `@orbitid/ui`, `@orbitid/shared`, `@orbitid/react` and `@orbitid/js` declare `sideEffects`, so unused components
  (drawers, OTP inputs, organization widgets) are dropped from every chunk.
- Pages never suspend. `lazy()` plus `<Suspense>` would hold a page back until its fallback had been visible for
  ~300 ms (React's anti-flash throttle), even with the chunk in cache, and the page's requests waited behind it.
  `lazyPage` (`src/lib/lazy-page.ts`) renders the layout's fallback while a page downloads and the page as soon as
  it arrives. The page for the current URL (or the sign-in page, when the boot check says signed out) starts
  downloading while the app's code evaluates, sidebar links preload on hover or focus, and the SDK sign-in starts
  its `/v1/client` requests as soon as its chunk arrives.
- Build-time `<link rel="preload">` hints were measured and left out: on a slow link they compete with the entry
  bundle, and only one of the two possible first screens is ever used.

## Design notes

- One signal red per screen, reserved for the active nav item, destructive actions and failures.
- Tables are ruled, never wrapped in a card. Row height 40px.
- Ids, keys and code use the mono face; nothing else does.
- Status is a word plus a dot, so it never depends on colour alone.
- Copy is sentence case, plain, and never names another vendor's product.
