# OrbitID architecture

OrbitID is open-source authentication and user management you run yourself: an auth server, a browser SDK, React components (shadcn/ui), Next.js and backend SDKs, and an admin dashboard. The server is a Rust process backed exclusively by your Postgres. This document describes how the pieces fit and the contracts between them. For running an instance, see [SELF_HOSTING.md](SELF_HOSTING.md).

## Repository (Cargo workspace + bun workspaces)

The server is a Cargo workspace at the repository root; the SDKs, dashboard and examples stay TypeScript.

| Path | Package | Purpose |
|---|---|---|
| `crates/orbitid-server` | binary `orbitid` | CLI, router composition, dashboard/docs serving, graceful shutdown |
| `crates/orbitid-{fapi-auth,fapi-account,bapi,oidc}` | HTTP surfaces | Frontend API (`/v1/client/*`), Backend API (`/v1/*`, secret key), OIDC/OAuth provider |
| `crates/orbitid-{identity,platform,credentials,federation}` | domain layers | users/sessions/orgs/RBAC, mail/webhooks/audit/uploads, keys/JWT/passwords/MFA, social & SAML |
| `crates/orbitid-core` | L0 | config, Postgres pool, row models, errors, settings, crypto, HTTP helpers |
| `packages/shared` | `@orbitid/shared` | Wire types (snake_case JSON), error codes, settings schema (zod), JWT claim types, webhook event names, key helpers |
| `packages/backend` | `@orbitid/backend` | Server-side SDK: `createOrbitIdClient`, `verifyToken`, webhook verification, `authenticateRequest` |
| `packages/js` | `@orbitid/js` | Framework-agnostic browser client (`OrbitID` class): resources, state, token refresh, cookies |
| `packages/ui` | `@orbitid/ui` | shadcn/ui primitives in `src/components/ui`, the activity board, and `src/styles.css` (Tailwind v4 tokens) |
| `packages/react` | `@orbitid/react` | `<OrbitIDProvider>`, hooks, control components, and the prebuilt UI components built from `@orbitid/ui` |
| `packages/nextjs` | `@orbitid/nextjs` | Next.js (App Router) integration: middleware, `auth()`, `currentUser()`, provider wrapper |
| `apps/dashboard` | `@orbitid/dashboard` | Vite + React admin dashboard over the Backend API |
| `apps/example-next` | `example-next` | Next.js demo app |
| `playground` | `orbitid-playground` | Test site that fills itself in from the running instance; not shipped |

Libraries are consumed as TypeScript source (`exports` point at `./src/index.ts`); there is no build step. Import siblings as `@orbitid/shared` and so on.

## Database

Postgres is the only database. `ORBITID_DATABASE_URL` (or `DATABASE_URL`) must start with `postgres://` or `postgresql://`; SQLite, PGlite and `:memory:` are refused at startup. Timestamps are epoch milliseconds everywhere. Queries use `sqlx` with runtime-checked SQL and one `#[derive(FromRow)]` row struct per table in `crates/orbitid-core/src/models`.

Migrations are plain SQL in `crates/orbitid-core/migrations` and run automatically before the server listens. `0001_baseline.sql` replays the old drizzle 0000–0009 schema exactly; an existing drizzle deployment is detected through `drizzle.__drizzle_migrations` and baselined, so pointing the Rust binary at a TypeScript-created Postgres database works in place. sqlx's advisory lock makes concurrent boots safe. Add a new numbered file for a schema change; never edit an applied migration.

Cross-replica state also lives in Postgres: rate-limit windows (`rate_limit_windows`), settings (with `LISTEN/NOTIFY` on `orbitid_settings`) and uploaded avatars/logos (`uploads`). Security-sensitive one-time transitions (verification codes, invitation tickets, OAuth state, backup codes and webhook claims) use conditional atomic database operations. Preserve these guards and use transactions for multi-step invariants when changing a flow; a sequence of individually atomic writes does not make the whole sequence atomic.

## Working in the repo

- The server builds and tests with Cargo (`cargo build`, `cargo test`, `cargo clippy`, `cargo fmt`). The frontend packages use bun (hoisted linker, see `bunfig.toml`; lockfile `bun.lock`); run scripts with `bun run <script>`.
- Rust tests need a Postgres admin connection in `ORBITID_TEST_PG_ADMIN_URL` (default `postgres://orbit:orbit@localhost:5432/postgres`). The harness creates a migrated template database once and clones it per test.
- `bun run typecheck` checks every TypeScript workspace; `bun run test` runs every vitest suite. The Node SDK tests spawn the real `target/release/orbitid` binary (or `ORBITID_BIN`) against a throwaway Postgres database.
- Change the schema in a new `crates/orbitid-core/migrations/NNNN_*.sql` file and add the matching row struct. Prefer the existing `jsonb` columns for loosely structured data.

## Conventions
- IDs: `orbitid_core::ids::new_id(prefix)`. Timestamps: epoch **ms** everywhere (DB + JSON). API JSON is snake_case; SDK-facing objects are camelCase.
- Errors: return `OrbitError` (`orbitid_core::error`); its `IntoResponse` writes `{ errors: [{code,message,long_message,meta}], trace_id }`. Accept JSON or urlencoded bodies with `OrbitJson<T>`. List endpoints: `?limit&offset&order_by=-created_at` → `{ data: [...], total_count }` (Backend API).
- Secrets: hash high-entropy opaque tokens with SHA-256; use the low-entropy digest helpers for numeric verification codes; compare in constant time; encrypt reversible secrets with the instance encryption key. Passwords use Argon2id. **Never log secrets or return password hashes / `private_metadata` from the Frontend API.**
- Rate limit sensitive endpoints through the Postgres-backed limiter in `orbitid_core::http::rate_limit`, so limits hold across replicas.
- Emit webhooks on every create/update/delete of user, session, org, membership, invitation, domain, role, permission, waitlist entry or API key.
- Settings: `state.settings.get()` (see `InstanceSettings` in `packages/shared/src/config.ts`) drives behaviour. Writes go through `state.settings.update(...)`, persist to `instance`, and publish `LISTEN/NOTIFY`; every replica refreshes within 30 s. UI is rendered from `GET /v1/client/environment`.

## Authentication model
- **Client** = a browser/device. Opaque token in httpOnly cookie `__client` (`Secure` when https; `SameSite=Lax`; Path=/; 400 days; on the API host) or `Authorization: Bearer <client token>` for non-browser. DB stores only `sha256(token)`. A Client has ≥0 **Sessions** (multi-session is the default; `session.multiSession: false` is the opt-in single-session mode) and at most one in-flight **sign_in** and **sign_up**.
- **Session JWT** (`__session` cookie written by `@orbitid/js` on the *app's* origin + `__client_uat` timestamp cookie): RS256, 60 s lifetime, refreshed by the SDK from the token's `exp` (about 50 s) via `POST /v1/client/sessions/:id/tokens`, with cross-tab locking and backoff (see below). Both cookies carry the 400-day browser maximum and are rewritten on every refresh. Claims in `shared/claims.ts`. Verified offline with JWKS (`/.well-known/jwks.json`). Custom claims via `settings.session.customClaims` and JWT templates (`POST /v1/client/sessions/:id/tokens/:template`).
- Sessions: statuses active|ended|expired|removed|abandoned|replaced|revoked|pending. By default they do **not** expire: `session.lifetimeSeconds: 0` means no maximum (a far-future `expire_at` is stored) and `inactivityTimeoutSeconds: 0` disables idle expiry; either limit is an explicit operator setting (`0` = unlimited, inactivity slides on token refresh/handshake, a maximum lifetime is absolute). A stored `expire_at` from an older default is ignored while the policy is unlimited. `touch` updates activity & active org; reverification via `factor_verification_age` (+ `has({reverification})`).
- Impersonation: **removed**. Neither actor tokens nor Backend-issued sign-in tokens exist; their endpoints refuse with `403`. Historical sessions keep `sessions.actor` so past activity still renders.

### Frontend API surface (`/v1/client`, all JSON/urlencoded, cookies, CORS credentials)
```
GET  /environment
GET  /                                  → { response: ClientJSON, client: ClientJSON }   (creates client+cookie if none)
DELETE /                                → sign out all sessions
GET  /sessions            POST /sessions/:id/touch {active_organization_id?}
POST /sessions/:id/end   POST /sessions/:id/remove   POST /sessions/:id/tokens   POST /sessions/:id/tokens/:template  → { jwt }
POST /sessions/:id/verify (start reverification) ; /prepare_first_factor /attempt_first_factor /prepare_second_factor /attempt_second_factor under /sessions/:id/verify/…
POST /sign_ins   GET /sign_ins/:id
POST /sign_ins/:id/{prepare_first_factor,attempt_first_factor,prepare_second_factor,attempt_second_factor,reset_password}
POST /sign_ups   GET|PATCH /sign_ups/:id   POST /sign_ups/:id/{prepare_verification,attempt_verification}
GET  /me   PATCH /me   DELETE /me   POST /me/profile_image  DELETE /me/profile_image
POST /me/change_password {current_password,new_password,sign_out_of_other_sessions}  POST /me/remove_password {current_password}
GET|POST /me/email_addresses   GET|DELETE /me/email_addresses/:id   POST /me/email_addresses/:id/{prepare_verification,attempt_verification}   PATCH /me → primary_email_address_id
GET|POST /me/phone_numbers  … same + PATCH (reserved_for_second_factor, default_second_factor)
POST /me/external_accounts {strategy, redirect_url, additional_scopes}   DELETE /me/external_accounts/:id
POST /me/totp   POST /me/totp/attempt_verification {code}   DELETE /me/totp
POST /me/backup_codes (regenerate; returns plaintext once)   
POST /me/passkeys (begin registration → options) POST /me/passkeys/:id/attempt_verification {public_key_credential}  PATCH|DELETE /me/passkeys/:id
GET  /me/sessions/active (other devices)  POST /me/sessions/:id/revoke
organizations: see below.   POST /waitlist {email_address}
```
Responses: `{ response: <resource>, client: ClientJSON }` for sign-in/up/session mutations (the SDK reads `client` to refresh state); plain resource JSON `{ response: ... }` for `me` sub-resources. Lists `{ response: [...] }`.

**Sign-in state machine** : `POST /sign_ins {identifier?, strategy?, password?, redirect_url?, ticket?}` → status `needs_identifier` | `needs_first_factor` (with `supported_first_factors` for the user: password, email_code, email_link, phone_code, passkey, oauth_*, enterprise_sso, reset_password_email_code) | `needs_second_factor` (totp, phone_code, backup_code; required when user has MFA or `settings.mfa.required`) | `needs_new_password` | `complete` (`created_session_id`). `prepare_first_factor` sends the code/link; `attempt_first_factor` verifies. Unknown identifiers get a decoy sign-in that fails like a wrong password (`enumerationProtection`, on by default); with it off they return `form_identifier_not_found`. Failed attempts increment `users.failedAttempts`; lock the user when exceeding `settings.mfa.maxAttempts`... (use `lockoutDurationSeconds`). Banned/locked users are rejected (`user_banned`, `user_locked`).
**Sign-up state machine**: `POST /sign_ups {email_address,password,username,first_name,last_name,phone_number,strategy?,redirect_url?,ticket?,unsafe_metadata,legal_accepted}` → `status: missing_requirements` + `missing_fields`/`unverified_fields` computed from `settings.attributes.*.required/verifyAtSignUp`; `PATCH` to add fields; `prepare_verification {strategy: email_code|email_link|phone_code}`, `attempt_verification {strategy, code}`; completes (`status: complete`, user+session created) when nothing is missing/unverified. Sign-up is gated by `services/restrictions.assertIdentifiersAllowed` (mode public/restricted/waitlist, allowlist, blocklist, invitation tickets). OAuth sign-ups are "transferable" between sign-in and sign-up (`sign_in.firstFactorVerification.status === "transferable"` → `signUp.create({transfer:true})`).
**OAuth**: `strategy: "oauth_google"` at `POST /sign_ins` or `/sign_ups` returns `first_factor_verification.external_verification_redirect_url` (browser navigates there) → provider → `/v1/oauth_callback/:provider` → `services/external-identity.handleExternalIdentity` → 302 back to `redirect_url`/`action_complete_redirect_url` with client cookie set. The Rust federation crate implements the providers (google, github, gitlab, discord, microsoft, apple, facebook, twitter/x, linkedin_oidc, slack, twitch, spotify, bitbucket, dropbox, notion, hubspot, tiktok, coinbase, line, linear, huggingface, box, atlassian, xero) **plus** generic OIDC `custom_<key>` providers using `discoveryUrl`. PKCE + state are stored in `oauth_states`.
**Other factors**: TOTP (secret encrypted at rest, QR as a data URL + `otpauth://` URI), backup codes (10 × 8 chars, hashed, single-use), passkeys (WebAuthn; RP id derived from the app origin of `redirect_url`/`Origin` header, challenges kept in `verifications`), email code / magic link, phone SMS code (Twilio / webhook via `services/mail.sendSms`; no console or file fallback).

### Organizations (Frontend API) — all under `/v1/client`
```
GET|POST /me/organization_memberships (GET: active user's, with org + role + permissions; supports ?paginated)   DELETE /me/organization_memberships/:orgId (leave)
GET  /me/organization_invitations   POST /me/organization_invitations/:id/accept
GET  /me/organization_suggestions   POST /me/organization_suggestions/:id/accept
POST /organizations {name, slug?}  GET|PATCH|DELETE /organizations/:id  PUT|DELETE /organizations/:id/logo
GET  /organizations/:id/memberships (?query,role,order_by, paginated)  PATCH|DELETE /organizations/:id/memberships/:userId  (PATCH {role})
GET|POST /organizations/:id/invitations {email_address, role, redirect_url}  (POST also supports bulk {email_addresses:[]}) POST /organizations/:id/invitations/:invId/revoke
GET|POST /organizations/:id/domains  GET|DELETE /organizations/:id/domains/:did  POST …/prepare_affiliation_verification {affiliation_email_address} POST …/attempt_affiliation_verification {code}  POST …/update_enrollment_mode {enrollment_mode, delete_pending}
GET  /organizations/:id/membership_requests   POST …/:rid/accept|reject      POST /organizations/:id/membership_requests (user requests to join)
GET  /organizations/:id/roles   (role set + permissions for the role dropdown)
```
RBAC: system roles `org:admin` (all system permissions) and `org:member` (read-only); system permissions `org:sys_profile:manage`, `org:sys_profile:delete`, `org:sys_memberships:read`, `org:sys_memberships:manage`, `org:sys_domains:read`, `org:sys_domains:manage`, `org:sys_billing:manage`; custom roles/permissions created via Backend API (`org:<feature>:<permission>`); every Frontend API org endpoint enforces the matching permission from the caller's membership. Last admin cannot leave/be demoted. Max memberships enforced. `has({role|permission})` works on the JWT (`org_role`, `org_permissions`).

### Backend API (`/v1`, `Authorization: Bearer sk_…`) — returns `private_metadata`
Users (list with `query,email_address[],phone_number[],username[],external_id[],user_id[],order_by,limit,offset`, count, get, create (with `password`/`password_digest`, `skip_password_checks`, metadata, `created_at`), update (profile/metadata/limits only), delete, ban/unban, lock/unlock, `PATCH /users/:id/metadata` (deep merge public/private/unsafe), `POST /users/:id/profile_image`, `GET /users/:id/organization_memberships`), email/phone reads, sessions (list, get, revoke, create tokens with `X-OrbitID-Session-Token` possession), clients (no freshly minted JWTs), refused credential/identifier routes (`verify_password`, `verify_totp`, `DELETE /users/:id/mfa`, `DELETE /users/:id/password`, email/phone writes, `/oauth_access_tokens/:provider`, `POST /sessions/:id/verify`, all 403), `GET|PUT /users/{id}/roles` (instance-wide `app:` roles), removed `sign_in_tokens`/`actor_tokens` (documented, always 403), instance-level `invitations` (+bulk, revoke), `waitlist_entries` (list/create/invite/reject), `allowlist_identifiers`, `blocklist_identifiers`, `jwt_templates`, `PATCH /instance` + `GET /instance` (InstanceSettings, secrets masked), `POST /testing_tokens`, `GET /audit_logs`, `GET /stats` (users/sessions/org counts + daily sign-ups for the dashboard charts), organizations (+ memberships, invitations, domains, metadata, logo), `roles`, `permissions` CRUD, webhooks (`/webhooks/endpoints`, `…/:id/deliveries`, `…/:id/rotate_secret`, `…/:id/test`), api keys, m2m, oauth applications, enterprise connections.
**Webhooks**: Svix-compatible signing: headers `svix-id`, `svix-timestamp`, `svix-signature: v1,<base64 hmac-sha256(secret_bytes, "id.timestamp.body")>` with secret `whsec_<base64>`. Retries with backoff (5s, 5m, 30m, 2h, 5h, 10h). `@orbitid/backend/webhooks` exports `verifyWebhook(req|{body,headers}, secret)`.

### API keys / M2M / OAuth provider / SSO
- **API keys**: opaque `ak_live_<random>` shown once; hashed; scopes; expiry; revoke; per-user and per-org subjects; `POST /v1/api_keys/verify {secret}` (Backend) → key metadata; `/v1/client/me/api_keys` & `/v1/client/organizations/:id/api_keys` self-service (also used by `<APIKeys/>` component).
- **M2M**: machines with secrets; `POST /v1/m2m/machines`, `/v1/m2m/tokens` (create using machine secret → opaque `mt_…` or JWT), `/v1/m2m/tokens/verify`, revoke, machine-to-machine scoping.
- **OIDC / OAuth2 provider** (OrbitID as IdP): `/.well-known/openid-configuration`, `/oauth/authorize` (login redirect to app sign-in if no session, consent screen data, PKCE S256 required for public clients), `/oauth/token` (authorization_code, refresh_token, client_credentials not needed), `/oauth/userinfo`, `/oauth/revoke`, `/oauth/introspect`, `/oauth/jwks` ; id_token signed with instance key. Management API `/v1/oauth_applications` CRUD + rotate secret; an application may be owned by an organization and limited to its members plus explicitly granted users ([APP_ACCESS.md](APP_ACCESS.md)).
- **Enterprise SSO**: SAML 2.0 SP (`samael` + libxmlsec): metadata, SP-initiated login, ACS (with signature validation), IdP-initiated optional, attribute mapping; enterprise OIDC connections (discovery + code flow). Domain-based routing: sign-in with identifier whose email domain matches an active connection returns `enterprise_sso` first factor. Both end in `handleExternalIdentity`.

## SDK contracts

### `@orbitid/js` — class `OrbitID`
```ts
const orbit = new OrbitID(publishableKey, { domain?, proxyUrl?, fetch? });
await orbit.load();               // GET /client + /environment, starts token refresh timer, writes __session / __client_uat cookies
orbit.loaded, orbit.client, orbit.session, orbit.user, orbit.organization (active), orbit.environment
orbit.addListener(cb) / orbit.on(...)       // cb({client, session, user, organization}) on any state change
orbit.signIn  // SignIn resource: create({identifier, strategy, password, redirectUrl, ticket, transfer}), prepareFirstFactor, attemptFirstFactor, prepareSecondFactor, attemptSecondFactor, authenticateWithRedirect({strategy, redirectUrl, redirectUrlComplete}), authenticateWithPasskey(), authenticateWithPopup? , resetPassword; fields: status, supportedFirstFactors, firstFactorVerification, identifier, createdSessionId …
orbit.signUp  // create, update, prepareEmailAddressVerification({strategy}), attemptEmailAddressVerification({code}), preparePhoneNumberVerification, attemptPhoneNumberVerification, authenticateWithRedirect; fields: status, missingFields, unverifiedFields, verifications …
orbit.setActive({session, organization, beforeEmit, redirectUrl}); orbit.signOut({sessionId, redirectUrl}); orbit.session.getToken({template, skipCache}); session.touch/end/remove/reverify (startVerification, attemptFirstFactorVerification …)
orbit.user: User resource: update, updatePassword, removePassword, createEmailAddress, createPhoneNumber, createExternalAccount, createTOTP, verifyTOTP, disableTOTP, createBackupCode, createPasskey, setProfileImage, delete, getSessions, leaveOrganization, getOrganizationMemberships (paginated), getOrganizationInvitations, getOrganizationSuggestions; fields camelCase (id, firstName, fullName, primaryEmailAddress, emailAddresses[], phoneNumbers[], externalAccounts[], publicMetadata, unsafeMetadata, imageUrl, hasVerifiedEmailAddress …) 
orbit.createOrganization({name, slug}), orbit.getOrganization(id), Organization resource: update, destroy, getMemberships, addMember, inviteMember, inviteMembers, getInvitations, getDomains, createDomain, getMembershipRequests, setLogo, getRoles; OrganizationMembership.update/destroy.
orbit.openSignIn() etc. are NOT needed — components are rendered by React. Navigation: `orbit.navigate(to)` configurable (`routerPush`/`routerReplace`).
```
Token cache: in-memory per session+template; the next refresh is scheduled from the token's `exp` (10 s leeway), not a fixed interval; cross-tab sync via BroadcastChannel plus a `localStorage` refresh lock so one tab mints and the rest reuse the shared cookie. Transient failures (network, 5xx, 429, offline, suspend) back off and keep the session; only a 401/403 confirmed by `GET /v1/client` clears it. Cookies: `__session` (JWT, `Path=/; SameSite=Lax`, 400 days), `__client_uat` (unix seconds, 0 when signed out, 400 days) so SSR/middleware can cheaply detect state.

### `@orbitid/react`
`<OrbitIDProvider publishableKey appearance localization routerPush routerReplace signInUrl signUpUrl afterSignOutUrl signInFallbackRedirectUrl …>`; hooks `useOrbitID`, `useAuth` ({isLoaded,isSignedIn,userId,sessionId,orgId,orgRole,orgSlug,has,getToken,signOut}), `useUser`, `useSession`, `useSessionList`, `useSignIn`, `useSignUp`, `useOrbitID`, `useOrganization` ({organization, membership, memberships, invitations, domains, membershipRequests, isLoaded} with paginated infinite options), `useOrganizationList` ({userMemberships, userInvitations, userSuggestions, setActive, createOrganization}), `useReverification`, control components `SignedIn, SignedOut, Protect({role,permission,condition,fallback}), RedirectToSignIn, RedirectToSignUp, AuthenticateWithRedirectCallback, OrbitIDLoaded, OrbitIDLoading`.
Prebuilt components (all built with `@orbitid/ui` shadcn primitives, react-hook-form where forms, fully driven by `environment`, with `appearance` prop {variables, theme, layout, elements-classNames} and `localization` object): `SignIn`, `SignUp`, `UserButton`, `UserProfile` (profile/security/organizations/apps/billing/API-keys pages: profile, emails, phones, connected accounts, password, passkeys, TOTP w/ QR, backup codes, active devices, delete account, the user's organizations and OAuth applications, billing-portal links), `OrganizationSwitcher`, `OrganizationProfile` (general, members, invitations, domains, membership requests, billing, API keys, danger zone); both profiles take `Page`/`Link` children to add, reorder, hide or replace pages ([ACCOUNT_PAGES.md](ACCOUNT_PAGES.md)), `OrganizationList`, `CreateOrganization`, `Waitlist`, `APIKeys`, `GoogleOneTap` (optional), `OAuthConsent`. Path- and hash-routing both supported (`routing="path"|"hash"|"virtual"`, `path`).

### `@orbitid/backend`
`createOrbitIdClient({secretKey, apiUrl})` → `.users .sessions .organizations .invitations .allowlistIdentifiers .blocklistIdentifiers .jwtTemplates .webhooks .apiKeys .m2m .oauthApplications .enterpriseConnections .waitlistEntries .instance .clients .testingTokens` (typed CRUD, paginated results `{data,totalCount}`), `verifyToken(jwt, {jwksUrl|jwtKey, authorizedParties, audience, expiredToleranceMs, notBeforeToleranceMs})`, `authenticateRequest(request, opts)` → signed-in/out state incl. `toAuth()` producing `AuthObject` with `has()`, `@orbitid/backend/webhooks#verifyWebhook`.

### `@orbitid/nextjs`
`orbitIdMiddleware((auth, req) => …, options)` + `createRouteMatcher`, `auth()` (async, returns AuthObject + `protect()`), `currentUser()`, `<OrbitIDProvider>` server wrapper (reads env `NEXT_PUBLIC_ORBITID_PUBLISHABLE_KEY`, `ORBITID_SECRET_KEY`, `NEXT_PUBLIC_ORBITID_SIGN_IN_URL` …), `@orbitid/nextjs/server` exports (`orbitIdClient`, `verifyWebhook`), route-handler/server-action helpers, Pages-router `getAuth(req)`.

## Dashboard (`apps/dashboard`)
Vite + React + react-router + TanStack Query + `@orbitid/ui` shadcn. The dashboard is served by the Rust server and talks to the same origin. Login is the instance's own account sign-in; an account with the Owner or Administrator role opens an httpOnly, same-origin console session (`POST /v1/operator_sessions/from_user`, or `/setup` for the first owner) → pages: Overview (stats + recharts sign-up chart + recent activity), Users (table, search/filter/sort/pagination, detail drawer/page: profile, identifiers, metadata editors, sessions, organizations, read-only MFA status, ban/lock, instance roles, delete), Organizations (list, detail: members/invitations/domains/roles), Roles & Permissions, Sessions, Invitations, Waitlist, Allow/Block lists, User & Auth settings (identifiers, password policy, social providers, MFA, sign-up mode, session lifetime), JWT templates (editor + shortcode help), Webhooks (endpoints, delivery log, retry, test), API Keys, M2M machines, OAuth apps, Enterprise SSO connections, Email/SMS settings, Appearance/branding, Audit logs. Dark mode. Same-origin with the server by default; the Vite dev server proxies the API (`ORBITID_DEV_API_URL`, default `http://localhost:4000`).

## Horizontal scaling

The server is stateless: every replica is interchangeable and no request depends on one process's memory.

- **Shared Postgres** is the single source of truth for users, sessions, settings, signing keys, rate-limit
  windows and uploaded images. Point every replica at the same `ORBITID_DATABASE_URL`.
- **Concurrent boots** are safe: the settings row is inserted with `INSERT … ON CONFLICT DO NOTHING`, and
  settings writes take a `SELECT … FOR UPDATE` row lock and merge onto the database value before validating
  and committing, so two replicas editing different fields both persist.
- **Settings** are written under the `instance` row lock, and that same `UPDATE` increments a
  database-assigned `revision`, which is the only publication order: a replica serves a snapshot
  only if its revision is greater than the one it already serves. Replicas learn about a commit
  from Postgres `LISTEN/NOTIFY` (channel `orbitid_settings`, payload = the new revision, skipped
  when already applied) and refresh within 30 s regardless, so propagation never depends on the
  replicas' clocks agreeing.
- **Rate limits** use the `rate_limit_windows` table plus a per-process negative cache, so a limit is not
  multiplied by the number of replicas.
- **Uploads** are rows in the `uploads` table, not files on a local disk. Any replica can serve any image.
- **Workers** (webhook retries, guest cleanup) take database locks, so two replicas do not deliver the same
  event twice. Each delivery claim carries a lease; its completion (or retry schedule) is conditional on that
  lease, so an attempt that outlived its claim cannot overwrite a newer worker's result.
- **`ORBITID_TRUST_PROXY`** must match the number of proxies in front of the server (1 behind one load
  balancer), so rate limits and session records see the client address and cookie security sees the original
  scheme.
- **Health**: `/health` is liveness (the process answers); `/ready` checks the database and is what a load
  balancer should use to take a replica out of rotation.

See [`docker-compose.scale.yml`](../docker-compose.scale.yml) for a three-replica example behind Caddy. It
uses Caddy dynamic upstreams (DNS refresh + round-robin + active `/ready` checks), not a one-off DNS lookup.
