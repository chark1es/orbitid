# Security model

OrbitID issues credentials, so the server is the part of a deployment that must be hardest to subvert. This
document states the threat model, every protection built into the server, what an operator running it has to do
themselves, and how to report a vulnerability.

The goal in one sentence: **nobody can inject into, hijack, or take over a running instance** — not a browser on
another site, not an unauthenticated caller, not a signed-in user reaching for somebody else's data, and not a
piece of content smuggled in through an upload or an outbound URL.

## Threat model

| Adversary | What they can reach | What they must not be able to do |
|---|---|---|
| Anonymous network caller | every public route | read or change tenant data; exhaust memory/CPU/disk with a cheap request; redirect the server into its own network |
| Another website in a visitor's browser | the visitor's cookies for this instance, including the dashboard's operator cookie if the browser happens to be signed in to a dashboard | make the browser perform a state-changing Frontend API or Backend API call (CSRF); frame the dashboard; read responses; use the operator session from another origin |
| Signed-in user (low privilege) | their own client, session and resources | read or change another user's or organisation's resources (IDOR); escalate roles; write privileged user fields (mass assignment) |
| Instance operator (holds the secret key) | the Backend API and settings | see stored third-party credentials in plaintext; point the server at internal services (SSRF); leak secrets into logs |
| Attacker who already read the database | stored rows | use OAuth/TOTP/signing/refresh secrets without the encryption key; mint a dashboard session from a stored token hash |

Out of scope, and therefore the operator's responsibility: the host OS, the database engine, the TLS terminator,
DNS, and anyone who legitimately holds the secret key or the encryption key.

## Protections in the server

### 1. Response headers

Every response gets `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`
and a `Permissions-Policy` that disables camera, microphone, geolocation, payment, USB and interest-cohort
(`packages/server/src/lib/security.ts`). `Strict-Transport-Security` (`max-age=31536000; includeSubDomains`) is
added when `ORBITID_BASE_URL` is `https://`.

The dashboard HTML (`packages/server/src/modules/dashboard.ts`) gets a strict CSP:

```
default-src 'self'; script-src 'self' 'nonce-<per-request>'; style-src 'self' 'unsafe-inline';
img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; object-src 'none';
base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

The only inline scripts are the page's own theme bootstrap and the injected instance configuration; both are
served with a fresh nonce per request, and the nonce in the header always matches the one in the HTML. External
scripts never get a nonce. `style-src` allows inline styles because the UI library injects them.
`ORBITID_DASHBOARD_CONNECT_SRC` adds extra `connect-src` origins for an operator who hosts the dashboard's API on
another origin; leave it empty for the normal same-origin deployment.

JSON API responses are `Cache-Control: no-store` unless the route chose its own public policy (the environment
and JWKS endpoints are cacheable and secret-free by design).

### 2. Cross-site request forgery

The Frontend API (`/v1/client/*`) is authenticated by the opaque `__client` cookie, which a browser attaches to
requests started by *any* site. Every state-changing method (POST/PUT/PATCH/DELETE) that arrives **with that
cookie** must therefore prove where it came from (`packages/server/src/lib/security.ts`, `csrfProtection`):

- `Origin` (or `Referer` when `Origin` is absent) must be one of `settings.application.allowedOrigins`,
  `homeUrl`, or this server's own base URL. In development mode `localhost` is additionally accepted.
  `allowedRedirectOrigins` is deliberately **not** on this list: it only says where a browser may be sent after
  sign-in, never who may call the API with a user's cookie (the same list governs CORS and the handshake).
- A literal `Origin: null` (sandboxed frames, some redirects) is refused.
- The same guard covers `POST /oauth/consent`, which records a grant for the signed-in user.
- A request flagged `Sec-Fetch-Site: cross-site` with no acceptable origin is refused (403).
- Requests without the `__client` cookie (bearer tokens, unauthenticated callers, server-side SDKs) are not
  affected, because a bearer token is not an ambient credential.

The Backend API checks the dashboard's operator cookie on reads and writes. Its `Origin` (or `Referer` when
`Origin` is absent) must be this instance's own origin. `Sec-Fetch-Site` must be `same-origin`, `none` or absent,
and a literal `Origin: null` is refused. Another application origin in `allowedOrigins` does not earn operator
access (`requireSecretKey` in `packages/server/src/middleware.ts`). The operator-session endpoints apply the
same rule. Frontend API requests and federation callbacks ignore this cookie and keep their own authentication
rules, so being signed into the dashboard does not prevent an operator from using their application.

Cookies are audited in one place each: `__client` is `HttpOnly`, `SameSite=Lax`, `Path=/`, 400 days (the
browser maximum), and `Secure` when the request is https — either `ORBITID_BASE_URL` or, behind a
TLS-terminating proxy at the configured `ORBITID_TRUST_PROXY` level, `X-Forwarded-Proto: https`. A plain-http
localhost instance gets no `Secure` attribute because the browser would refuse the cookie. `__session` and
`__client_uat` are written by the browser SDK with the same 400-day cap; the JWT inside `__session` still
expires in about 60 s and is refreshed continuously. The dashboard's `__orbit_operator` is `HttpOnly`,
`SameSite=Strict`, `Path=/v1`, 8 hours, and `Secure` over https. The OAuth/SAML browser-binding cookie
`__orbit_oauth` is `HttpOnly`, `Path=/v1`, 10 minutes, and `SameSite=None; Secure` over https because SAML ACS
and Apple `form_post` callbacks are cross-site POSTs.

### 3. Request limits

- JSON bodies: 1 MB, enforced by a counting reader before `JSON.parse` (and a `Content-Length` pre-check), so an
  oversized body is refused while it is still on the wire.
- Uploads (multipart, image data URLs): 5 MB, enforced by middleware before any route parses them and again in
  the upload handler.
- `Content-Type` must be JSON or form-encoded for JSON endpoints; anything else that carries a body is a 415.
- JSON nested deeper than 32 levels is a 400, because such documents only exist to exhaust recursive validators.
- Zod schemas bound user-writable metadata (100 keys, 256-character keys, 4 KB strings, 16 KB serialised) and
  every Frontend API text field; list `limit`/`offset` are capped (500 / 0) on every list endpoint.
- The node server is started with `maxHeaderSize: 16 KB`, `requestTimeout: 30s`, `headersTimeout: 20s`,
  `keepAliveTimeout: 5s` (`packages/server/src/index.ts`), so a slow or idle peer cannot pin a socket.

### 4. Server-side request forgery

Outbound requests to URLs a user or admin controls all go through one helper,
`packages/server/src/lib/safe-fetch.ts`. It is used for webhook delivery, OIDC discovery/token/userinfo endpoints
(social custom providers and enterprise connections), JWKS retrieval, SAML/enterprise discovery, CAPTCHA
verification, the SMS webhook and the breached-password check.

`safeFetch`:

1. accepts only `http:`/`https:` and strips embedded credentials;
2. resolves DNS itself and refuses private (10/8, 172.16/12, 192.168/16), loopback (127/8, `::1`), link-local and
   cloud-metadata (169.254/16, including 169.254.169.254), CGNAT (100.64/10), multicast, reserved, documentation
   and benchmarking ranges, plus IPv6 unique-local (`fc00::/7`), link-local (`fe80::/10`), multicast and
   IPv4-mapped addresses;
3. connects to the **resolved, vetted address** while sending the original `Host` and TLS SNI, so a second DNS
   answer cannot redirect the connection (DNS rebinding);
4. follows redirects itself, at most 3, re-validating every hop before connecting;
5. caps the response body (1 MB default) and the total time (10 s default).

Private destinations are reachable only when `settings.application.developmentMode` is true or
`ORBITID_ALLOW_PRIVATE_NETWORKS=true` (server scope), which is what lets tests and local setups use localhost
webhooks. Webhook endpoint URLs are also validated when they are created or updated, so an operator is told
immediately that an internal target is refused.

### 5. Uploads

`packages/server/src/lib/images.ts` decides the format from the bytes: PNG, JPEG, GIF and WebP only. SVG is
refused unconditionally, as is anything else, regardless of the declared `Content-Type` or file extension.
Polyglots — a real image header followed by HTML, SVG or script — are refused too. Stored files get a random,
server-generated name (the client's name is never used), and are served with `X-Content-Type-Options: nosniff`
and `Content-Security-Policy: sandbox`. The existing path-traversal guard on the image and logo routes stays.

### 6. Injection and abuse

- **Dynamic sorting** only ever maps a whitelisted column name to a Drizzle column (`parseOrderBy`, `sortRows`);
  an unknown `order_by` falls back to the default order and is never interpolated.
- **LIKE searches** escape `%`, `_` and `\` and use an explicit `ESCAPE` clause (`containsText`,
  `startsWithText` in `lib/db.ts`).
- **No `sql.raw` with input.** All queries are Drizzle-parameterised.
- **Prototype pollution**: `deepMerge` (settings), both `mergeMetadata` helpers, request-body parsing and the JWT
  shortcode lookup all drop `__proto__`, `constructor` and `prototype` at every level.
- **Mass assignment**: every Frontend API write is an explicit allowlist. A user cannot set `banned`, `locked`,
  `passwordHash`, `isAnonymous`, `privateMetadata`, `externalId` or any other privileged field — a PATCH to
  `/v1/client/me` only reads the fields its schema names.
- **JWT templates** resolve dot-paths against a fixed, per-user context; they cannot execute code, cannot reach
  `Object.prototype`, and cannot read secrets (the context holds only user, session, org and membership data).
  A template token is marked `token_type: "jwt_template"` and is refused everywhere a session is accepted —
  the server's bearer-session routes, `@orbitid/backend` `verifyToken`/`authenticateRequest` and the `@orbitid/node`
  adapters — even when it is signed with the instance key. A 10-year template lifetime therefore cannot become a
  10-year session that survives logout, a ban or a role change. Verify one deliberately with
  `verifyToken(token, { tokenType: "jwt_template" })` (Node: `orbit.verifyToken(token, { tokenType: "jwt_template" })`).
- **API keys follow their subject.** A key is invalid while its user is banned or currently locked, and banning a
  user revokes every key issued for them, so a credential cannot outlive the account's access.
- **Disabled webhook endpoints stop delivery.** Queued attempts are skipped without consuming a retry while the
  endpoint is disabled; re-enabling it resumes the queue.
- **Log injection**: values written to logs are passed through `logSafe`, which escapes control characters
  (including CR/LF), so a crafted header or email cannot forge log lines. Secrets, tokens, codes and passwords
  are never logged.
- **Regex DoS**: no user-supplied value ever becomes a regular expression.
- **Enumeration**: an unknown identifier or a user without a password spends the same password-hashing work as a
  real check (`spendPasswordCheck`), so response timing does not reveal whether an account exists. Setting
  `security.enumerationProtection` additionally makes both paths return the same neutral response.
- **Session fixation**: when a session is created, the browser's `__client` token is rotated, so a token captured
  before sign-in is useless afterwards.
- **IDOR**: every `/v1/client/*` route that takes an id scopes its query to the caller (own user, own client,
  or a membership with the required permission). Negative tests use two users and a non-member for each of those
  routes.

### 7. Authentication surface

- The Backend API secret key is compared with `safeEqual` (constant time); failed attempts are rate limited per
  IP (10 failures / 5 minutes → 429), and a key offered in the query string is refused outright because query
  strings end up in proxy logs and browser history. The dashboard's key exchange
  (`POST /v1/operator_sessions`) shares that per-address failure budget and uses the same constant-time
  comparison, so presenting the key in two places does not double the guessing budget.
- The Backend API accepts two credentials: the bearer secret key (unchanged, for servers and SDKs) and the
  dashboard's httpOnly operator cookie. The cookie is only honoured on this instance's own origin, only over a
  session row whose token hash matches, and only while the row is unexpired, unrevoked and bound to the current
  key. A browser request that carries it with `Sec-Fetch-Site: cross-site` is refused.
- OIDC: `redirect_uri` must match a registered value **verbatim**, PKCE is required for public clients and
  anything marked `pkce_required`, and only `S256` is accepted.
- JWT verification pins algorithms: session tokens and machine tokens accept `RS256` only, so `none` and
  HS256-with-the-public-key ("algorithm confusion") are rejected. Enterprise `id_token`s are verified with an
  explicit asymmetric algorithm list.
- SAML is handled by `@node-saml/node-saml`: assertion signatures are mandatory, responses must answer a request
  we issued (unless IdP-initiated is explicitly enabled), replay is refused, and the XML parser does not expand
  external entities (XXE). Signature wrapping is the library's responsibility; we pass it a single, validated
  assertion and reject a response whose assertion is not the signed one.
- Passwords are argon2id (`m=19456, t=2, p=1` in production). Imported bcrypt and scrypt digests still verify.
- Account lockout: `settings.mfa.maxAttempts` failures lock the account for `lockoutDurationSeconds`.
- Backup codes are 10 characters from a 32-symbol alphabet (50 bits each), single-use, stored as SHA-256 hashes.
- Every token, code and signature comparison uses `safeEqual`.
- **A first-factor attempt cannot relabel what was prepared.** `attempt_first_factor` refuses a `strategy`
  different from the one `prepare_first_factor` recorded (`400 client_state_invalid`), and password recovery
  derives its channel and identifier from the verified `reset_password` row rather than the request body. A code
  sent to an email address can never be submitted — or persisted — as a phone recovery, or vice versa.
- **First-factor steps are state-bound and single use.** `prepare_first_factor` and `attempt_first_factor` are
  refused (`400 client_state_invalid`) unless the sign-in is still waiting for a first factor, so an attempt that
  already escalated to MFA or completed a password reset cannot be walked back to an earlier step. A
  `reset_password` verification is consumed with a conditional `UPDATE` when the password is written: replaying
  the code — even in a parallel request — finds it spent and changes nothing. The same state gate stops replayed
  `email_code`, `phone_code` and `email_link` attempts after they produced a session or reached the second factor.
- **Required MFA fails closed after recovery.** When `mfa.required` is on and the account has enrolled a factor,
  recovery cannot mint a session if excluding the channel it just used leaves no eligible second factor. The
  password reset still completes, but the sign-in returns `needs_first_factor` for the new password instead of an
  active session; the normal password flow then asks for the second factor. An account that never enrolled a
  factor keeps the previous pending-session behaviour, so nobody is locked out for lacking MFA.

**No operator path to a user's session.** Holding the secret key is not the same as being any user, and the Backend
API is built so that administration cannot be turned into a sign-in:

- Impersonation (actor) tokens and one-time sign-in tokens were removed; their routes always answer `403`, and a
  ticket already in the database is refused. No new session is created with an `actor`.
- An existing account's credentials and sign-in identifiers are not operator-editable. `PATCH /v1/users/:id` refuses
  `password`, `password_digest`, `totp_secret`, `backup_codes`, `primary_email_address_id` and
  `primary_phone_number_id`; `DELETE /v1/users/:id/password` and `DELETE /v1/users/:id/mfa` refuse; the
  `email_addresses` and `phone_numbers` write routes (attach, verify, promote, second factor, delete) refuse. Each
  answers `403 not_allowed_access` and names the user-facing `/me` route. A password the operator sets, an
  authenticator they enrol, an address they verify or a factor they clear would each let them sign in as that user.
- `verify_password` and `verify_totp` are refused for the same reason plus one more: they run outside the sign-in
  lockout, so they would be unmetered oracles against a password or a 30-second code.
- Minting a session JWT for an arbitrary session id is refused. `POST /v1/sessions/:id/tokens` requires
  `X-OrbitID-Session-Token` to carry that session's own valid JWT (the SDK forwards the token it just verified), and
  the client serializers the Backend API uses never include a freshly signed JWT. Reading a user's provider access
  token is refused too, since it is another way to act as them.
- `POST /v1/sessions/:id/verify` is refused: the operator cannot assert a first or second factor the browser never
  presented, which is what an MFA bypass looks like in the token's `fva` claim.
- Initial provisioning is unchanged: `POST /v1/users` still imports verified identifiers, a password digest and MFA
  material for a *new* account. What the API will not do is reach into an account that already belongs to someone.

This is an application-level boundary, not a cryptographic one against the machine's owner: whoever runs the server
controls the database, the encryption key, the mail and SMS credentials and the process memory, so they can always
recover an account out of band. The point is that the *product's own API and console* offer no shortcut to signing in
as a user; an operator who needs to help uses a password reset or an invitation to the address the user controls.

**The server does not narrate authentication.** A rejected secret key, a failed dashboard key exchange, a failed
sign-in, an undeliverable code and an unexpected error on an auth route all produce no console output. Delivery
failures are returned to the caller as typed results and recorded as audit entries carrying the template and reason
only — never a code, link, recipient or provider secret. Startup prints no secret key: `orbitid start` reports that
it is hidden and points at `orbitid keys`, which the operator runs deliberately. Diagnostics that would otherwise
land in shared logs (which are read by more people and kept longer than the rows they concern) are simply not
written.

### 8. Session persistence

Sessions have **no expiry by default** (`session.lifetimeSeconds: 0`, `inactivityTimeoutSeconds: 0`). A session
ends only on the user's sign-out, an operator revocation, or a ban; a password change, role change, email change,
reverification, organization switch or MFA enrolment does not end it. Refreshes are never treated as failures:
the browser SDK backs off and retries, only a confirmed 401/403 clears local state, and the Next.js handshake
recovers an expired 60 s JWT from the live `__client` cookie instead of redirecting to sign-in. Signing keys live
in the database and a changed `ORBITID_ENCRYPTION_KEY` aborts startup rather than silently invalidating every
session. See [SESSIONS.md](SESSIONS.md) for the full guarantees, the causes that were audited, and the cookie
attributes.

**Clock tolerance is split.** 60 s on `nbf`/`iat` but 10 s on `exp`: a 60 s JWT is usable ~70 s. SDK verifiers
share it; backend's verifier is exact.

**Session end ends OIDC credentials.** Sign-out, revoke, ban, removal and expiry revoke the session's
grants; userinfo, introspection and refresh re-check it. Recovery revokes grants and trusted devices.

### 9. Secrets

`GET /v1/instance` (and any settings response) masks credentials — `smtpUrl`, `resendApiKey`, `captchaSecret`,
`twilioAuthToken`, social `clientSecret`, `applePrivateKey` and enterprise connection secrets — as `••••` with a
sibling `<field>Set` boolean. A PATCH that sends a mask back, or echoes the stored plaintext unchanged, keeps the
stored value; an empty string clears it; anything else replaces it. This makes the dashboard's whole-object
editor safe.

The same fields are **encrypted at rest** in the instance settings JSON with the instance encryption key
(`lib/crypto.ts`, AES-256-GCM). Rows written by older versions hold plaintext: they are read as-is and sealed on
the next write, so the migration is transparent. An unreadable ciphertext (wrong key) degrades to an empty value
instead of crashing the instance.

Webhook endpoint secrets are returned only when the endpoint is created (and when the secret is rotated, or read
from the dedicated secret endpoint). They never appear in list or detail responses.

### 10. Dependencies

`bun audit` checks dependency advisories against the committed lockfile and currently reports no known
vulnerabilities. `drizzle-orm` and `nodemailer` include fixes for the identifier-escaping and message-level
raw-option issues. Keep the lockfile committed and run `bun audit` as part of maintenance.

## The self-hoster's responsibilities

The server hardens what it controls; these parts are yours.

1. **TLS.** Terminate TLS in front of OrbitID and set `ORBITID_BASE_URL` to the `https://` URL users reach. That
   single setting turns on HSTS and `Secure` cookies. Never run a production instance over plain http: the
   browser-binding cookie for cross-site SSO callbacks needs https, and so does `Secure`.
2. **Reverse proxy.** Put nginx, Caddy, or your load balancer in front. Forward to the node port, set
   `X-Forwarded-For`, and set `ORBITID_TRUST_PROXY` to the number of proxies you run (1 for a single proxy) so
   per-IP rate limits see the real client and not the proxy. Do not expose the node port directly to the
   internet. If your proxy adds security headers of its own, keep them consistent with this document rather than
   loosening them; the server's headers are set only when the route has not chosen them.
   The server caps request headers at 16 KB; keep your proxy's limit at or below that.
3. **Key handling.**
   - `ORBITID_ENCRYPTION_KEY` is required in production and must be at least 32 random characters
     (`openssl rand -base64 32`). It encrypts signing keys, TOTP secrets, OAuth tokens and settings credentials.
     Keep it stable and back it up separately from the database: changing it makes every stored secret unreadable.
   - The secret key (`sk_live_…`) is generated on first boot (derived from the encryption key, or written to
     `<dataDir>/keys.json` with mode 600). Treat it like a root password: it grants the entire Backend API.
     Rotate it if it leaks, and do not put it in a browser. `orbitid start` does not print it — run
     `orbitid keys` when you need the value, rather than reading it out of a captured startup log.
   - Keep the data directory (`ORBITID_DATA_DIR`) on a private volume; it holds keys and uploaded images.
4. **Database.** Store the database credentials in the environment, not in the settings UI. Use a dedicated
   database user with access only to the OrbitID database, and keep Postgres patched.
5. **Network.** Only the server needs to reach your database and the outbound services you configured (mail, SMS,
   CAPTCHA, IdP). Block egress to your internal network and to the cloud metadata address at the network layer as
   well — `safeFetch` is the application-level guard, not a substitute for a firewall.
6. **Upgrades.** Watch dependency advisories and upgrade. Run `bun audit` (or your registry's equivalent) as part
   of maintenance, and rebuild the image when a fix lands.
7. **Backups and logs.** Back up the database and the data directory together. Scrub logs before sharing them:
   trace ids and user ids are fine, tokens and codes are never logged by the server and never written to disk by it — there is no console or file mail transport at all — but may appear in your proxy's
   logs if a client puts them in a URL.

## Behind a reverse proxy

Set `ORBITID_TRUST_PROXY` to the number of proxies in front of the server and make the outermost one **append the client
address to `X-Forwarded-For`** (nginx: `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`, Caddy and Traefik do
this by default). The server reads the right-hand hop of that header and ignores `X-Real-IP`, which a client could set.
A proxy that sends only `X-Real-IP` leaves the server seeing the proxy's address for everyone, so every per-address limit
(sign-in, sign-up, device codes, secret-key failures) is shared; the server logs one warning when it notices.

## Things that are deliberate

- **First claim wins when email is not verified.** With `attributes.emailAddress.verifyAtSignUp` off, nobody proves a
  mailbox at sign-up, so the first account to use an address keeps it, and a later plain sign-up with the same address is
  refused. An identity provider that has verified the address (Google, a verified GitHub address, an enterprise IdP) takes
  precedence: signing in through it replaces the unproven claim. Leave email verification on if mailbox ownership matters.

- **Account enumeration.** `security.enumerationProtection` (off by default) makes sign-in answer an unknown
  identifier like a known one. It is off because the friendly "couldn't find your account, sign up?" message is what most
  apps want, and because sign-up must say when an address is already registered. Turn it on if hiding which addresses have
  accounts matters more to you than that message. Failed attempts are rate limited and unknown identifiers cost the same
  password work either way.
- **Authorization requests are not CSRF-protected.** `GET /oauth/authorize` is a top-level navigation by design (the
  OAuth protocol requires it). What keeps it safe is that a code can only be sent to a `redirect_uri` registered for the
  client, is bound to PKCE, and a client with `consent_screen_enabled: false` is treated as first-party. Only turn the
  consent screen off for apps you run yourself; anyone who can register an OAuth application on your instance can see
  the profile of any signed-in user who visits a page that starts an authorization for it.
- **Invitation links.** Opening an organization invitation link while signed in as the invited address accepts it. The
  link is the capability (it was emailed to that address); an inviter cannot use it against anyone but the invitee.

## Dashboard sign-in

The dashboard has no accounts of its own: the operator pastes the instance secret key once, and the page trades it
for an httpOnly session in the same request. The secret key is never written to `sessionStorage`, `localStorage` or
`document.cookie`, and no response returns the key, so a script that runs in the dashboard's origin can act as the
operator while the session is live but cannot exfiltrate the secret key.

- `POST /v1/operator_sessions` compares the key with `safeEqual` and rate limits failures per address (10 / 5
  minutes → 429), sharing the budget with the bearer gate. The key is accepted only from this instance's own
  origin, so a malicious site cannot use the endpoint as an oracle against another instance.
- The response is an opaque 256-bit token in `__orbit_operator`: `HttpOnly`, `SameSite=Strict`, `Path=/v1`,
  `Secure` over https, 8 hours. The server stores only its sha256 hash, so a database reader cannot mint a session.
- Each row is bound to an HMAC fingerprint of the secret key. Rotating the key ends every session, and sign-out
  revokes the row immediately (`DELETE /v1/operator_sessions/current`), so a copied cookie stops working. A
  database transfer deliberately leaves these rows behind (`docs/DATA_MOVE.md`), so an export can never restore a
  live operator login on another instance.
- The cookie is accepted by the Backend API only from this origin, on reads as well as writes. `Sec-Fetch-Site` must
  be `same-origin`, `none` or absent; an explicit `Origin` is authoritative, so `null`, a malformed value or another
  host is refused and `Referer` is never consulted in its place; `Referer` is used only when no `Origin` was sent.
  Another application origin in `allowedOrigins` does not qualify, and `SameSite=Strict` means a cross-site request
  never carries the cookie anyway. The Frontend API's separate CSRF guard checks its own client cookie.
- The dashboard's CSP allows scripts only from its own origin plus one nonce-tagged bootstrap script, with no
  inline handlers and no `eval`; the app renders every server string through React text nodes (there is no
  `dangerouslySetInnerHTML` anywhere in it); and the page is served with `frame-ancestors 'none'` and `no-store`.
- External dashboards are not supported by a weaker fallback. A dashboard that is not served by the instance it
  manages cannot receive the same-origin cookie, so the page refuses to send the key to another origin rather than
  falling back to a bearer token in browser storage. Serve the built dashboard from the server (the container image
  does this) or place it behind the same origin with a reverse proxy; keep it behind your TLS and, if you can, a VPN
  or an allowlist.

Operator accounts (a named user per operator, roles, and per-operator audit) are the next step for this surface;
the session table and the audit events are shaped so that change does not touch the API contract.

## Dependency status

`bun audit` reports no advisory for a production dependency. The validation layer runs on zod 4 across the
server, the shared contract and the OpenAPI converter, so the zod 3 memory advisory (very large arrays carrying a
length constraint) no longer applies. Regression tests confirm that overlong constrained arrays are refused
before validating their elements. A separate 1 MB request-body cap remains in place. Development tooling
(vitest, vite, esbuild, postcss) is
kept on patched versions through `overrides` in the root `package.json`.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

- Use GitHub's private vulnerability reporting on the repository (Security → Report a vulnerability), or email the
  maintainers at the address listed in `SECURITY.md` if one is published.
- Include: the affected version or commit, a description of the issue, the impact you believe it has, and
  reproduction steps or a proof of concept. A minimal request/response or a failing test is ideal.
- We will acknowledge the report, confirm the issue privately, prepare a fix and a regression test, and credit you
  in the release notes if you want to be named.
- Please give us a reasonable window to ship a fix before public disclosure, and do not test against instances you
  do not own.

Secret-key failure budgets are checked before comparing subsequent bearer or operator-exchange credentials.
Once an address exhausts the budget, even a correct key must wait until the failure window expires. Successful
traffic does not consume that budget. Explicit production secret keys require at least 32 random characters;
omitting the override uses the strong derived key.

Imported password digests are validated before storage and again before verification. Digests are at most
1,024 characters. Argon2 accepts at most 64 MiB, 8 iterations, 4 lanes and 256 MiB-rounds; bcrypt cost is 4–14;
scrypt accepts power-of-two N up to 65,536, r up to 16, p up to 4, at most 128 MiB and N*r*p up to 2,097,152.
Scrypt verification uses the asynchronous crypto API instead of blocking the event loop. Imports exceeding the
limits return 422; existing unsupported/high-cost digests fail closed and require a user password-reset flow.
Initial user provisioning/import may supply password digests and MFA material for a new account; existing-account
credential replacement is still refused. This distinction is intentional, not an impersonation escape hatch.
