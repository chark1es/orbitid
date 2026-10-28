# OrbitID architecture (read fully before coding)

OrbitID is a self-hostable, open-source Clerk alternative: a hosted-style auth server + browser SDK + React components (shadcn/ui) + Next.js and backend SDKs + admin dashboard. **Mirror Clerk's concepts, API shapes and naming wherever possible** (`useUser`, `useSignIn`, `<SignIn/>`, `clerkMiddleware` → `orbitIdMiddleware`, `auth()`, `has()`, etc.). If you know how Clerk does it, do it that way.

## Monorepo (npm workspaces, TypeScript, ESM, Node 20)

| Path | Package | Purpose |
|---|---|---|
| `packages/shared` | `@orbitid/shared` | Wire types (snake_case JSON), error codes, settings schema (zod), JWT claim types, webhook event names, key helpers. **Lead-owned. Additive edits only.** |
| `packages/server` | `@orbitid/server` | Hono + Drizzle(SQLite/better-sqlite3) auth server: Frontend API (`/v1/client/*`), Backend API (`/v1/*`, secret key), OIDC provider, SAML, JWKS |
| `packages/backend` | `@orbitid/backend` | Server-side SDK: `createOrbitIdClient`, `verifyToken`, webhook verification, `authenticateRequest` |
| `packages/js` | `@orbitid/js` | Framework-agnostic browser client (`OrbitID` class — like clerk-js): resources, state, token refresh, cookies |
| `packages/ui` | `@orbitid/ui` | **shadcn/ui primitives** (already installed in `src/components/ui`, do not re-add) + `src/styles.css` (Tailwind v4 tokens) |
| `packages/react` | `@orbitid/react` | `<OrbitIDProvider>`, hooks, control components, **and the prebuilt UI components built from `@orbitid/ui`** |
| `packages/nextjs` | `@orbitid/nextjs` | Next.js (App Router) integration: middleware, `auth()`, `currentUser()`, provider wrapper |
| `apps/dashboard` | `@orbitid/dashboard` | Vite + React admin dashboard (shadcn) over the Backend API |
| `apps/example-next` | `example-next` | Next.js demo app using everything |

Libraries are consumed **as TypeScript source** (`exports` → `./src/index.ts`); there is no build step. Import siblings as `@orbitid/shared` etc.

### Tooling rules (IMPORTANT)
- **Package manager: bun** (hoisted linker, see `bunfig.toml`; lockfile `bun.lock`). All common deps are pre-installed. If you truly need a new dep: `cd <workspace dir> && bun add <pkg>` (dev: `bun add -d`). Never use npm/yarn/pnpm. Other workers run concurrently; keep installs rare. Scripts: `bun run <script>`.
- **Runtime stays Node 20 for the server and tests** (`/usr/bin/node`): `better-sqlite3` is a native addon that does not load under Bun's runtime. After any `bun install`/`bun add`, verify with `node -e "require('better-sqlite3')"`; if it fails: `cd node_modules/better-sqlite3 && /usr/bin/node ../prebuild-install/bin.js`.
- Run binaries from `node_modules/.bin` (`../../node_modules/.bin/vitest run`, `tsc -p tsconfig.json`, `tsx`).
- Typecheck your package before finishing: `cd <pkg> && ../../node_modules/.bin/tsc -p tsconfig.json`. Tests: vitest. Write real tests for every feature (server tests use `testApp()` from `packages/server/test/boot.test.ts` pattern: in-memory DB, `app.request(...)`).
- Do **not** touch files owned by another worker. Do **not** git commit/push/stash/checkout/reset; the lead commits. Do not edit `packages/server/src/app.ts` (all module files are already mounted there – just fill your module files).
- DB schema (`packages/server/src/db/schema.ts`) is lead-owned. If you absolutely need a column/table: make a minimal **additive** edit, then run `cd packages/server && ../../node_modules/.bin/drizzle-kit generate` and mention it in your final report. Prefer storing extra data in the existing JSON columns.
- No placeholder implementations. No `TODO: implement`. If something is genuinely out of scope, say so in your final report with the reason.

## Conventions
- IDs: `newId(ID_PREFIX.x)` from `src/lib/ids.ts`. Timestamps: epoch **ms** everywhere (DB + JSON). API JSON is snake_case; SDK-facing objects are camelCase.
- Errors: `throw new OrbitError(status, ErrorCodes.x, "message", meta?)`. Wire format `{ errors: [{code,message,long_message,meta}], trace_id }`. Validate bodies with `parseBody(c, zodSchema)` (JSON or urlencoded). List endpoints: `?limit&offset&order_by=-created_at` → `{ data: [...], total_count }` (Backend API) .
- Secrets: hash one-time tokens/codes with `sha256`; compare with `safeEqual`; encrypt reversible secrets with `encrypt(ctx.env.encryptionKey, ...)`. Passwords: argon2id via `@node-rs/argon2`. **Never log secrets or return password hashes / private_metadata from Frontend API.**
- Rate limit sensitive endpoints with `hit(ctx, key, max, windowMs)` from `lib/rate-limit.ts`.
- Emit webhooks with `emitEvent(ctx, "user.created", userJSON)` (services/webhooks.ts) on every create/update/delete of user, session, org, membership, invitation, domain, role, permission, waitlist entry, api key.
- Settings: `ctx.settings.get()` (see `InstanceSettings` in shared/config.ts) drives behaviour (required attributes, enabled strategies, password policy, org features, etc.). UI is rendered from `GET /v1/client/environment`.

## Authentication model (same as Clerk)
- **Client** = a browser/device. Opaque token in httpOnly cookie `__client` (`Secure` when https; `SameSite=Lax`; Path=/; on the API host) or `Authorization: Bearer <client token>` for non-browser. DB stores only `sha256(token)`. A Client has ≥0 **Sessions** (multi-session optional) and at most one in-flight **sign_in** and **sign_up**.
- **Session JWT** (`__session` cookie written by `@orbitid/js` on the *app's* origin + `__client_uat` timestamp cookie): RS256, 60 s lifetime, refreshed by the SDK every ~50 s via `POST /v1/client/sessions/:id/tokens`. Claims in `shared/claims.ts`. Verified offline with JWKS (`/.well-known/jwks.json`). Custom claims via `settings.session.customClaims` and JWT templates (`POST /v1/client/sessions/:id/tokens/:template`).
- Sessions: statuses active|ended|expired|removed|abandoned|replaced|revoked|pending; expire after `settings.session.lifetimeSeconds`; `touch` updates activity & active org; reverification via `factor_verification_age` (+ `has({reverification})`).
- Impersonation: Backend creates `actor_token`; redeeming it via sign-in `ticket` strategy creates a session with `actor` → JWT `act` claim.

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

**Sign-in state machine** (identical semantics to Clerk): `POST /sign_ins {identifier?, strategy?, password?, redirect_url?, ticket?}` → status `needs_identifier` | `needs_first_factor` (with `supported_first_factors` for the user: password, email_code, email_link, phone_code, passkey, oauth_*, enterprise_sso, reset_password_email_code) | `needs_second_factor` (totp, phone_code, backup_code; required when user has MFA or `settings.mfa.required`) | `needs_new_password` | `complete` (`created_session_id`). `prepare_first_factor` sends the code/link; `attempt_first_factor` verifies. Unknown identifiers return `form_identifier_not_found` (unless `enumerationProtection`). Failed attempts increment `users.failedAttempts`; lock the user when exceeding `settings.mfa.maxAttempts`... (use `lockoutDurationSeconds`). Banned/locked users are rejected (`user_banned`, `user_locked`).
**Sign-up state machine**: `POST /sign_ups {email_address,password,username,first_name,last_name,phone_number,strategy?,redirect_url?,ticket?,unsafe_metadata,legal_accepted}` → `status: missing_requirements` + `missing_fields`/`unverified_fields` computed from `settings.attributes.*.required/verifyAtSignUp`; `PATCH` to add fields; `prepare_verification {strategy: email_code|email_link|phone_code}`, `attempt_verification {strategy, code}`; completes (`status: complete`, user+session created) when nothing is missing/unverified. Sign-up is gated by `services/restrictions.assertIdentifiersAllowed` (mode public/restricted/waitlist, allowlist, blocklist, invitation tickets). OAuth sign-ups are "transferable" between sign-in and sign-up like Clerk (`sign_in.firstFactorVerification.status === "transferable"` → `signUp.create({transfer:true})`).
**OAuth**: `strategy: "oauth_google"` at `POST /sign_ins` or `/sign_ups` returns `first_factor_verification.external_verification_redirect_url` (browser navigates there) → provider → `/v1/oauth_callback/:provider` → `services/external-identity.handleExternalIdentity` → 302 back to `redirect_url`/`action_complete_redirect_url` with client cookie set. Use `arctic` (providers: google, github, gitlab, discord, microsoft, apple, facebook, twitter/x, linkedin_oidc, slack, twitch, spotify, bitbucket, dropbox, notion, hubspot, tiktok, coinbase, line, linear, huggingface, box, atlassian, xero) **plus** generic OIDC `custom_<key>` providers using `discoveryUrl`. PKCE + state stored in `oauth_states`.
**Other factors**: TOTP (otplib, secret encrypted at rest, QR via `qrcode` data URL + `otpauth://` uri), backup codes (10 × 8 chars, hashed, single-use), passkeys (`@simplewebauthn/server` v10, RP id derived from the app origin of `redirect_url`/`Origin` header, challenges kept in `verifications`), email code / magic link, phone SMS code (Twilio / webhook / console via `services/mail.sendSms`).

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
RBAC: system roles `org:admin` (all system permissions) and `org:member` (read-only); system permissions `org:sys_profile:manage`, `org:sys_profile:delete`, `org:sys_memberships:read`, `org:sys_memberships:manage`, `org:sys_domains:read`, `org:sys_domains:manage`; custom roles/permissions created via Backend API (`org:<feature>:<permission>`); every Frontend API org endpoint enforces the matching permission from the caller's membership. Last admin cannot leave/be demoted. Max memberships enforced. `has({role|permission})` works on the JWT (`org_role`, `org_permissions`).

### Backend API (`/v1`, `Authorization: Bearer sk_…`) — returns `private_metadata`
Users (list with `query,email_address[],phone_number[],username[],external_id[],user_id[],order_by,limit,offset`, count, get, create (with `password`/`password_digest`, `skip_password_checks`, metadata, `created_at`), update, delete, ban/unban, lock/unlock, `PATCH /users/:id/metadata` (deep merge public/private/unsafe), verify_password, verify_totp, `DELETE /users/:id/mfa`, `POST /users/:id/profile_image`, `GET /users/:id/organization_memberships`, `/oauth_access_tokens/:provider`), email/phone CRUD, sessions (list, get, revoke, verify, create tokens), clients, `sign_in_tokens`, `actor_tokens` (+revoke), instance-level `invitations` (+bulk, revoke), `waitlist_entries` (list/create/invite/reject), `allowlist_identifiers`, `blocklist_identifiers`, `jwt_templates`, `PATCH /instance` + `GET /instance` (InstanceSettings, secrets masked), `POST /testing_tokens`, `GET /audit_logs`, `GET /stats` (users/sessions/org counts + daily sign-ups for the dashboard charts), organizations (+ memberships, invitations, domains, metadata, logo), `roles`, `permissions` CRUD, webhooks (`/webhooks/endpoints`, `…/:id/deliveries`, `…/:id/rotate_secret`, `…/:id/test`), api keys, m2m, oauth applications, enterprise connections.
**Webhooks**: Svix-compatible signing: headers `svix-id`, `svix-timestamp`, `svix-signature: v1,<base64 hmac-sha256(secret_bytes, "id.timestamp.body")>` with secret `whsec_<base64>`. Retries with backoff (5s, 5m, 30m, 2h, 5h, 10h). `@orbitid/backend/webhooks` exports `verifyWebhook(req|{body,headers}, secret)`.

### API keys / M2M / OAuth provider / SSO
- **API keys**: opaque `ak_live_<random>` shown once; hashed; scopes; expiry; revoke; per-user and per-org subjects; `POST /v1/api_keys/verify {secret}` (Backend) → key metadata; `/v1/client/me/api_keys` & `/v1/client/organizations/:id/api_keys` self-service (also used by `<APIKeys/>` component).
- **M2M**: machines with secrets; `POST /v1/m2m/machines`, `/v1/m2m/tokens` (create using machine secret → opaque `mt_…` or JWT), `/v1/m2m/tokens/verify`, revoke, machine-to-machine scoping.
- **OIDC / OAuth2 provider** (OrbitID as IdP): `/.well-known/openid-configuration`, `/oauth/authorize` (login redirect to app sign-in if no session, consent screen data, PKCE S256 required for public clients), `/oauth/token` (authorization_code, refresh_token, client_credentials not needed), `/oauth/userinfo`, `/oauth/revoke`, `/oauth/introspect`, `/oauth/jwks` ; id_token signed with instance key. Management API `/v1/oauth_applications` CRUD + rotate secret.
- **Enterprise SSO**: SAML 2.0 SP (`@node-saml/node-saml`): metadata, SP-initiated login, ACS (with signature validation), IdP-initiated optional, attribute mapping; enterprise OIDC connections (discovery + code flow). Domain-based routing: sign-in with identifier whose email domain matches an active connection returns `enterprise_sso` first factor. Both end in `handleExternalIdentity`.

## SDK contracts (mirror Clerk)

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
Token cache: in-memory per session+template; refresh 10 s before expiry; cross-tab sync via BroadcastChannel. Cookies: `__session` (JWT, `Path=/; SameSite=Lax`), `__client_uat` (unix seconds, 0 when signed out) so SSR/middleware can cheaply detect state.

### `@orbitid/react`
`<OrbitIDProvider publishableKey appearance localization routerPush routerReplace signInUrl signUpUrl afterSignOutUrl signInFallbackRedirectUrl …>`; hooks `useOrbitID`, `useAuth` ({isLoaded,isSignedIn,userId,sessionId,orgId,orgRole,orgSlug,has,getToken,signOut}), `useUser`, `useSession`, `useSessionList`, `useSignIn`, `useSignUp`, `useClerk`-equivalent `useOrbitID`, `useOrganization` ({organization, membership, memberships, invitations, domains, membershipRequests, isLoaded} with paginated infinite options), `useOrganizationList` ({userMemberships, userInvitations, userSuggestions, setActive, createOrganization}), `useReverification`, control components `SignedIn, SignedOut, Protect({role,permission,condition,fallback}), RedirectToSignIn, RedirectToSignUp, AuthenticateWithRedirectCallback, OrbitIDLoaded, OrbitIDLoading`.
Prebuilt components (all built with `@orbitid/ui` shadcn primitives, react-hook-form where forms, fully driven by `environment`, with `appearance` prop {variables, theme, layout, elements-classNames} and `localization` object): `SignIn`, `SignUp`, `UserButton`, `UserProfile` (account/security/sessions/organizations tabs: profile, emails, phones, connected accounts, password, passkeys, TOTP w/ QR, backup codes, active devices, delete account), `OrganizationSwitcher`, `OrganizationProfile` (general, members, invitations, domains, membership requests, danger zone), `OrganizationList`, `CreateOrganization`, `Waitlist`, `APIKeys`, `GoogleOneTap` (optional), `OAuthConsent`. Path- and hash-routing both supported (`routing="path"|"hash"|"virtual"`, `path`).

### `@orbitid/backend`
`createOrbitIdClient({secretKey, apiUrl})` → `.users .sessions .organizations .invitations .allowlistIdentifiers .blocklistIdentifiers .jwtTemplates .actorTokens .signInTokens .webhooks .apiKeys .m2m .oauthApplications .enterpriseConnections .waitlistEntries .instance .clients .testingTokens` (typed CRUD, paginated results `{data,totalCount}`), `verifyToken(jwt, {jwksUrl|jwtKey, authorizedParties, audience, clockSkewInMs})`, `authenticateRequest(request, opts)` → signed-in/out state incl. `toAuth()` producing `AuthObject` with `has()`, `@orbitid/backend/webhooks#verifyWebhook`.

### `@orbitid/nextjs`
`orbitIdMiddleware((auth, req) => …, options)` + `createRouteMatcher`, `auth()` (async, returns AuthObject + `protect()`), `currentUser()`, `<OrbitIDProvider>` server wrapper (reads env `NEXT_PUBLIC_ORBITID_PUBLISHABLE_KEY`, `ORBITID_SECRET_KEY`, `NEXT_PUBLIC_ORBITID_SIGN_IN_URL` …), `@orbitid/nextjs/server` exports (`orbitIdClient`, `verifyWebhook`), route-handler/server-action helpers, Pages-router `getAuth(req)`.

## Dashboard (`apps/dashboard`)
Vite + React + react-router + TanStack Query + `@orbitid/ui` shadcn. Login with the instance secret key (stored in sessionStorage) → pages: Overview (stats + recharts sign-up chart + recent activity), Users (table, search/filter/sort/pagination, detail drawer/page: profile, identifiers, metadata editors, sessions, organizations, MFA reset, ban/lock, impersonate, delete), Organizations (list, detail: members/invitations/domains/roles), Roles & Permissions, Sessions, Invitations, Waitlist, Allow/Block lists, User & Auth settings (identifiers, password policy, social providers, MFA, sign-up mode, session lifetime), JWT templates (editor + shortcode help), Webhooks (endpoints, delivery log, retry, test), API Keys, M2M machines, OAuth apps, Enterprise SSO connections, Email/SMS settings, Appearance/branding, Audit logs. Dark mode. Backend API base URL from `VITE_ORBITID_API_URL` (default `http://localhost:4000`).
