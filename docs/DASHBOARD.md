# Dashboard

The dashboard is `apps/dashboard`: Vite + React + react-router + TanStack Query over the Backend API, built
from the `@orbitid/ui` primitives and the Timetable design system in [`DESIGN.md`](../DESIGN.md). The
server serves the built files at `/` when `apps/dashboard/dist` exists.

## Sign-in and the operator session

The dashboard signs in with the instance secret key exactly once. `POST /v1/operator_sessions` compares the
key in constant time (rate limited per address, like the Backend API itself) and answers with an httpOnly
cookie, `__orbit_operator`, scoped to `Path=/v1`, `SameSite=Strict` and `Secure` whenever the instance is
served over https. The cookie holds an opaque 256-bit token; the server stores only its sha256 hash. The key
is never written to `sessionStorage`, `localStorage` or `document.cookie`, and no response ever returns it.

Every Backend API call from the dashboard then authenticates with that cookie. `Authorization: Bearer sk_…`
still works unchanged for servers, SDKs and scripts; the cookie is only accepted from the instance's own
origin, so a Backend API on another host or another browser origin cannot read it.

- The session lasts 8 hours (`OPERATOR_SESSION_TTL_MS`). `GET /v1/operator_sessions/current` confirms it on
  load, so an expired or revoked cookie lands on `/login` without a flash of the shell.
- **Sign out** (`DELETE /v1/operator_sessions/current`) revokes the row and clears the cookie; replaying the
  old token is refused. Signing in again in the same tab revokes the previous session.
- Rotating the secret key ends every operator session, because each row is bound to a fingerprint of the key
  it was approved with.
- Operator sessions are audit-logged (`operator_session.created`, `operator_session.revoked`).

The API origin is the server that served the page (`window.__ORBITID__.apiUrl`), falling back to the page's
own origin. A dashboard on a different origin from its API cannot use the cookie and refuses to sign in;
serve the built dashboard from the server, as a container deployment does.

Sign-out revokes the session on the server before the shell reports success. If revocation fails (the server is
unreachable, or answers `5xx`) the dashboard keeps the session and shows the error, because the cookie is still
live; only a `401` — the session was already gone — counts as a completed sign-out.

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
- the live operator session (the secret key is a placeholder: the dashboard no longer holds it);
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

## Design notes

- One signal red per screen, reserved for the active nav item, destructive actions and failures.
- Tables are ruled, never wrapped in a card. Row height 40px.
- Ids, keys and code use the mono face; nothing else does.
- Status is a word plus a dot, so it never depends on colour alone.
- Copy is sentence case, plain, and never names another vendor's product.
