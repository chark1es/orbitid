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
| Another website in a visitor's browser | the visitor's cookies for this instance | make the browser perform a state-changing Frontend API call (CSRF); frame the dashboard; read responses |
| Signed-in user (low privilege) | their own client, session and resources | read or change another user's or organisation's resources (IDOR); escalate roles; write privileged user fields (mass assignment) |
| Instance operator (holds the secret key) | the Backend API and settings | see stored third-party credentials in plaintext; point the server at internal services (SSRF); leak secrets into logs |
| Attacker who already read the database | stored rows | use OAuth/TOTP/signing/refresh secrets without the encryption key |

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

Cookies are audited in one place each: `__client` is `HttpOnly`, `SameSite=Lax`, `Path=/`, one year, and
`Secure` whenever the base URL is https. The OAuth/SAML browser-binding cookie `__orbit_oauth` is `HttpOnly`,
`Path=/v1`, 10 minutes, and `SameSite=None; Secure` over https because SAML ACS and Apple `form_post` callbacks
are cross-site POSTs.

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
  strings end up in proxy logs and browser history.
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

### 8. Secrets

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

### 9. Dependencies

`bun audit` works offline with the committed lockfile; its current findings and our assessment are in the report
for this change. Two are relevant to the server and are addressed by available upgrades rather than by code:
`drizzle-orm` (identifier escaping) and `nodemailer` (message-level raw option). Everything the audit reports
under `vite`, `vitest`, `esbuild` and `@vitest/mocker` is development tooling that is not part of a production
image.

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
     Rotate it if it leaks, and do not put it in a browser.
   - Keep the data directory (`ORBITID_DATA_DIR`) on a private volume; it holds keys and uploaded images.
4. **Database.** Store the database credentials in the environment, not in the settings UI. Use a dedicated
   database user with access only to the OrbitID database, and keep Postgres patched.
5. **Network.** Only the server needs to reach your database and the outbound services you configured (mail, SMS,
   CAPTCHA, IdP). Block egress to your internal network and to the cloud metadata address at the network layer as
   well — `safeFetch` is the application-level guard, not a substitute for a firewall.
6. **Upgrades.** Watch dependency advisories and upgrade. Run `bun audit` (or your registry's equivalent) as part
   of maintenance, and rebuild the image when a fix lands.
7. **Backups and logs.** Back up the database and the data directory together. Scrub logs before sharing them:
   trace ids and user ids are fine, tokens and codes are never logged by the server (the one opt-in exception is `ORBITID_ALLOW_CONSOLE_EMAIL=true`, which exists for trials) but may appear in your proxy's
   logs if a client puts them in a URL.

## Things that are deliberate

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

The dashboard has no accounts of its own yet: an operator pastes the instance secret key, which the page keeps in
`sessionStorage` (this tab only; it is gone when the tab closes) and sends as a bearer token. That means any script
that runs in the dashboard's origin can read the key. The defenses are around that surface rather than around the
key: the dashboard's CSP allows scripts only from its own origin plus one nonce-tagged bootstrap script, with no
inline handlers and no `eval`; the app renders every server string through React text nodes (there is no
`dangerouslySetInnerHTML` anywhere in it); and the page is served with `frame-ancestors 'none'` and `no-store`. Keep
the dashboard on its own origin, behind your TLS and, if you can, behind a VPN or an allowlist. Operator accounts with
an httpOnly session are the next step for this surface.

## Dependency status

`bun audit` is clean except for one advisory in `zod` 3.x (memory use when validating very large arrays that carry
a length constraint). Fixing it means moving the whole codebase to zod 4, which changes validation behavior across
every endpoint, so it is tracked separately. It is not reachable in practice: request bodies are capped at 1 MB
before any validation runs, so the memory a request can cost is bounded by that cap. Development-only tooling
(vitest, vite, esbuild, postcss) is kept on patched versions through `overrides` in the root `package.json`.

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
