# Dashboard

The dashboard is `apps/dashboard`: Vite + React + react-router + TanStack Query over the Backend API, built
from the `@orbitid/ui` primitives and the Timetable design system in [`DESIGN.md`](../DESIGN.md). The
server serves the built files at `/` when `apps/dashboard/dist` exists.

Sign-in is the instance secret key, kept in `sessionStorage`, so a reload keeps the session and closing the
tab ends it. The API origin is chosen on the sign-in screen; it defaults to the server that served the page
(`window.__ORBITID__.apiUrl`), then `VITE_ORBITID_API_URL`, then `http://localhost:4000`.

## Pages

| Route | Page | What it does |
|---|---|---|
| `/` | Overview | Instance stats, the sign-up chart and the live activity board. Shows the keys and the database in use. |
| `/users` | Users | Server-side search, filters, sorting and pagination; bulk actions. |
| `/users/:id` | User detail | Profile, identifiers, metadata, sessions, organizations, MFA reset, ban/lock, impersonate, delete. |
| `/organizations`, `/organizations/:id` | Organizations | Members, invitations, domains, membership requests and roles. |
| `/sessions` | Sessions | Every session on the instance, with a revoke action. |
| `/invitations`, `/waitlist` | Invitations, Waitlist | Instance-level invitations and the waitlist. |
| `/restrictions` | Restrictions | Allowlist and blocklist entries, sign-up restrictions. |
| `/roles` | Roles & permissions | Custom roles and the `org:<feature>:<action>` permission keys. |
| `/settings/authentication` | Authentication | Identifiers, password policy, second factors (including email code as a second factor), sign-up mode, guest accounts, captcha and abuse protection. |
| `/settings/social` | Social connections | OAuth providers and custom OIDC connections. Apple takes a team ID, key ID and `.p8` private key instead of a client secret. |
| `/settings/sessions` | Sessions settings | Session lifetime, token refresh, trusted devices, custom JWT claims. |
| `/settings/organizations` | Organizations settings | Whether users may create organizations, membership limits, domains, roles. |
| `/settings/email-sms` | Email & SMS | Branding, the mail transport (automatic, Resend, SMTP, print to log), the from address, code lifetimes, a real test send, and SMS delivery. |
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

## Connect your app

`/connect` reads the running instance rather than placeholders:

- the publishable key, from the public `GET /health`;
- the API URL the dashboard is pointed at;
- the secret key of the signed-in session;
- the database dialect reported by `/health`.

It then renders, per framework tab (Next.js, React + backend, Node with Express, plain Node script), one
install line and two labelled blocks: **Website · browser (public)** and **Website · backend (secret)**.
Variable names follow the SDKs (`NEXT_PUBLIC_*` for Next.js, `VITE_*` for Vite, `ORBITID_*` for the Node
SDKs). The webhook secret is per endpoint — it comes from the Webhooks page — and is left blank in the
block with a line saying where to find it. `ORBITID_JWT_KEY` is optional and commented out.

Secrets are masked on screen and revealed with one toggle; copying always copies the real values, and
"Copy all" pastes both blocks as one file. A read-only **Server (this instance)** block reports the
database, base URL, the email provider in effect and whether private networks are allowed, and points at
`docs/ENVIRONMENT.md`. The encryption key never appears anywhere in the dashboard.

**Check your setup** calls `GET /health` and `GET /v1/client/environment` and reads the saved settings,
then reports each result with a word and a dot (Works, Check, Failed): server reachable, publishable key
present, secret key in this session, sign-in methods published, email transport, and whether the
application home URL is an allowed origin.

## Secret fields

Every credential in instance settings is write-only. `GET /v1/instance` replaces a stored secret with a
mask (`••••`) and adds a `<field>Set` marker, and `PATCH` drops a mask or an unchanged echo instead of
storing it (`packages/server/src/lib/secrets.ts`).

The dashboard mirrors that convention in `pages/_config/settings.ts`: `secretInputValue` blanks a masked
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
