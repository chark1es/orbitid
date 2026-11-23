# Environment variables

Three different programs read environment variables, and each one needs a different set. Every variable below carries one of these labels, and `.env.example` files in the repo use the same labels.

| Label | Where it is set | Who can see it |
| --- | --- | --- |
| **SERVER** | The machine or container that runs OrbitID | Only you |
| **WEBSITE · BACKEND (secret)** | The server side of the website or API that uses OrbitID (Next.js server, Express, a worker) | Only you. Never ship it to a browser |
| **WEBSITE · BROWSER (public)** | Your website's build, where the framework inlines it into client code | Everyone who loads the site |

Rule of thumb: a value that can read or change users (the secret key, the encryption key, an email provider key) never goes under BROWSER. The dashboard's **Connect your app** page prints copy-ready blocks for each label from your running instance.

## SERVER

Set these where OrbitID runs: the container environment, `docker compose`'s `.env`, or the shell that starts
`orbitid`. Nothing here belongs in a website. The server is Postgres-only.

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `ORBITID_ENCRYPTION_KEY` | **yes** (always with Postgres or a public base URL) | none | At least 32 characters. Encrypts signing keys, TOTP secrets, OAuth tokens and stored provider secrets, and derives the secret key. Keep it stable and backed up: changing it makes stored secrets unreadable, and the server refuses to start when a stored signing key cannot be decrypted (it never regenerates one, which would sign every user out). |
| `ORBITID_DATABASE_URL` | **yes**, unless the separate parts below are set | none | `postgres://…` or `postgresql://…`. `DATABASE_URL` also works. When a URL is set it wins over the parts. A password containing `/ + = @ : %`, `?`, `#` or a space must be percent-encoded in a URL (`openssl rand -base64 32` output often contains `/`, `+` and `=`); to avoid encoding altogether use the parts below. SQLite, PGlite and `:memory:` were removed with the TypeScript server, and a leftover `ORBITID_DATABASE_PATH` makes startup fail with an explicit error instead of being ignored. |
| `ORBITID_DATABASE_HOST` / `PGHOST` | **yes** with parts | none | Database host. Used only when no URL is set. |
| `ORBITID_DATABASE_PORT` / `PGPORT` | no | `5432` | Database port. |
| `ORBITID_DATABASE_USER` / `PGUSER` | no | `postgres` | Database user. |
| `ORBITID_DATABASE_PASSWORD` / `PGPASSWORD` | no | none | Database password, passed to the server byte for byte: no URL-encoding, any characters. The docker-compose files use this form. |
| `ORBITID_DATABASE_NAME` / `PGDATABASE` | no | the user name | Database name. Each `ORBITID_DATABASE_*` part falls back to the standard libpq variable shown next to it. Every command that connects (`start`, `migrate`, `export`, `import`, `copy`, `import-uploads`, `keys`) resolves the connection the same way. |
| `ORBITID_BASE_URL` | yes in production | `http://localhost:<port>` | The URL browsers and your apps use to reach the server. It is the token issuer. |
| `PORT` / `ORBITID_PORT` | no | `4000` | Port to listen on. |
| `ORBITID_BIND` | no | `127.0.0.1` | Read only by `deploy/docker-compose.yml`, not by the server: the host address the port is published on. `0.0.0.0` exposes it on every interface; keep it local until the owner account exists. |
| `ORBITID_SECRET_KEY` | no | derived from the encryption key | Backend API key. Omit it to derive a strong key; an explicit production key must contain at least 32 random characters. Print the effective key with `orbitid keys`. |
| `ORBITID_DB_MAX_CONNECTIONS` | no | `20` | Maximum pooled Postgres connections per replica. Each replica also opens one dedicated `LISTEN` connection for settings changes, so keep `replicas × (this + 1)` below Postgres's `max_connections` (the bundled compose file sets `300`). |
| `ORBITID_DB_ACQUIRE_TIMEOUT_MS` | no | `30000` | How long a request waits for a pooled connection before failing. |
| `ORBITID_DATA_DIR` | no | `./data` | A writable directory created at startup. Uploads are stored in Postgres, so this holds no deployment data (the image uses `/tmp/orbitid`). |
| `ORBITID_DASHBOARD_DIR` | no | built dashboard next to the server | Folder holding the built dashboard. |
| `ORBITID_REQUEST_TIMEOUT_MS` | no | `30000` | Maximum time one request may take before the server answers 503. `0` disables the timeout. |
| `ORBITID_DRAIN_TIMEOUT_MS` | no | `10000` | After SIGTERM, in-flight requests get this long to finish before the process exits. |
| `ORBITID_DASHBOARD_CONNECT_SRC` | no | none | Extra `connect-src` origin(s) for the dashboard's Content-Security-Policy, for example a separate API host when the dashboard is not same-origin. |
| `ORBITID_WEBHOOK_RETENTION_DAYS` | no | `30` | Delete webhook deliveries that reached a terminal state (`success` or `failed`) and events whose deliveries are all terminal, once they are older than this many days. `0` keeps them forever. |
| `ORBITID_AUDIT_RETENTION_DAYS` | no | `0` | Delete audit-log rows older than this many days. The default `0` keeps audit logs forever, because audit trails are often a compliance requirement. |
| `ORBITID_RETENTION_BATCH_SIZE` | no | `500` | Rows deleted per table per batch inside one retention tick. A full batch makes the operation continue immediately until the table is drained or the tick budget is spent. |
| `ORBITID_RETENTION_INTERVAL_MS` | no | `3600000` | How often the retention worker starts a tick (one hour). Must be a positive integer. |
| `ORBITID_RETENTION_BUDGET_MS` | no | `30000` | Maximum time one retention tick spends draining batches. The first batch of every operation always runs; the next tick continues where this one stopped. `0` means one batch per operation per tick. |
| `ORBITID_ENROLLMENT_INTERVAL_MS` | no | `60000` | Interval of the domain-enrollment reconciliation worker. A verified `automatic_invitation` domain is marked pending in the same transaction as the change; the worker (woken immediately by the request, and every interval thereafter, on every replica) resumes each pending domain from its saved cursor, chunk by chunk, and clears the marker when the pass reaches the end. Each tick uses `ORBITID_RETENTION_BUDGET_MS` and attempts at least one domain, continuing after the last attempted one so a failing domain cannot starve the rest. A user whose membership insert keeps failing is skipped (logged with domain and user id, counted in the tick outcome) and the pass continues; an organization at its membership capacity ends the pass and the marker clears (those users are enrolled by their next email verification or the next mode toggle). A chunk that fails for any other reason (for example a failing webhook outbox insert) discards nothing: the failure count, last error and next attempt are stored on the domain (`enrollment_failures`, `enrollment_last_error`, `enrollment_next_attempt_at`), the domain is retried with exponential back-off (30 s doubling, capped at 1 h), each failure is logged at `error` with the domain id, and a successful chunk resets the counters. |
| `ORBITID_COPY_FROM_HOST` / `_PORT` / `_USER` / `_PASSWORD` / `_NAME` | no | none / `5432` | Source database of `orbitid copy` when `--from` is not given (`HOST` and `NAME` required). The password is taken byte for byte, no URL-encoding, and never appears in the process list. See [DATA_MOVE.md](DATA_MOVE.md). |
| `ORBITID_COPY_TO_HOST` / `_PORT` / `_USER` / `_PASSWORD` / `_NAME` | no | none / `5432` | Target database of `orbitid copy` when `--to` is not given; same rules as the `FROM` variables. |
| `ORBITID_TRUST_PROXY` | no | `0` | Number of reverse proxies in front of the server (`true` means 1). Also makes `X-Forwarded-Proto: https` decide the `Secure` attribute of the client-session cookies. The dashboard operator-session cookie is different: its `Secure` attribute comes from `ORBITID_BASE_URL` only, so a TLS-terminating proxy must set an `https://` base URL (the server warns at startup when it sees `ORBITID_TRUST_PROXY` with a plain-http non-local base URL). See [SELF_HOSTING.md](SELF_HOSTING.md#behind-a-reverse-proxy). |
| `ORBITID_ALLOW_PRIVATE_NETWORKS` | no | `false` | Let outbound calls (webhooks, identity providers) reach private addresses. Development mode allows them anyway. See [SECURITY.md](SECURITY.md). |
| `ORBITID_UPDATE_CHECK` | no | `true` | Ask GitHub whether a newer OrbitID release exists, so the dashboard can show **Update available**. One unauthenticated `GET https://api.github.com/repos/chark1es/orbitid/releases/latest` per replica every 6 hours (1 hour after a failure), sent with the `orbitid/<crate version>` user agent (the `Cargo.toml` version, even when the image was built with `ORBITID_BUILD_VERSION`) and nothing about the instance. A repository with no published release counts as "no update". A failure is silent and keeps the last answer. `false` (or `0`, `no`, `off`) sends no request; the running version is still shown. Any other value stops startup. See [UPDATES.md](UPDATES.md#version-and-update-check). |
| `ORBITID_RESEND_API_KEY` | no | none | Send email through Resend. See [EMAIL.md](EMAIL.md). |
| `ORBITID_SMTP_URL` | no | none | Send email through SMTP, `smtps://user:password@host:465`. |
| `ORBITID_EMAIL_FROM` | no | `OrbitID <no-reply@localhost>` | From address for all email. |
| `NODE_ENV` | no | `development` | Set to `production` in deployments (the Docker image does). Turns on production checks. |
| `POSTGRES_PASSWORD` | **yes** (docker compose) | none | Password of the bundled Postgres container. Compose refuses to start until it is set; use `openssl rand -hex 32`. Compose hands it to the server as `ORBITID_DATABASE_PASSWORD`, so any characters are safe. |

Everything else about how sign-in behaves (identifiers, password rules, providers, MFA, sessions,
organizations, branding) is an instance setting edited in the dashboard, not an environment variable. Email
settings can live in either place; an environment value fills in when the dashboard setting is empty.

## WEBSITE · BACKEND (secret)

Set these on the server side of your own app: the Next.js server, an Express or Fastify process, a worker. They authorize calls to the Backend API and verify tokens. Never expose them to the browser, and never prefix them with `NEXT_PUBLIC_`.

| Variable | Required | Read by | Meaning |
| --- | --- | --- | --- |
| `ORBITID_SECRET_KEY` | **yes** | `@orbitid/nextjs`, `@orbitid/node`, `@orbitid/backend` | Backend API key (`sk_…`). Retrieve it explicitly with `orbitid keys` (from source: `cargo run -q -p orbitid-server -- keys`). The dashboard and startup logs do not reveal it. |
| `ORBITID_API_URL` | **yes**, unless a publishable key is given | `@orbitid/node`, `@orbitid/backend` | URL of your OrbitID server (`https://auth.example.com`). There is no hosted default, so the SDK refuses to start without it (or `ORBITID_PUBLISHABLE_KEY`, which carries the URL). |
| `ORBITID_WEBHOOK_SECRET` | only to receive webhooks | all backend SDKs | Signing secret (`whsec_…`) of the webhook endpoint you registered in the dashboard. |
| `ORBITID_JWT_KEY` | no | `@orbitid/nextjs` | PEM public key (SPKI, X.509 certificate or a private key, whose public half is used) to verify session tokens without fetching the key set. A bare string without a PEM header is refused rather than treated as an HMAC secret; for HMAC, opt in explicitly with the `hs256:` prefix (`hs256:<secret>`, ≥16 characters). |
| `ORBITID_JWKS_URL` | no | `@orbitid/node` | Key set URL when it is not `<api url>/.well-known/jwks.json`. |
| `ORBITID_AUTHORIZED_PARTIES` | no | `@orbitid/nextjs` | Comma-separated origins accepted in the token's `azp` claim. |
| `ORBITID_ISSUER` | no | `@orbitid/node` | The server's public URL, which tokens carry as `iss`. Defaults to the URL in the publishable key, else `ORBITID_API_URL`. Set it when this process reaches the server on an internal address (`http://orbitid:4000`) but tokens are issued for the public one. |
| `ORBITID_AUDIENCE` | no | `@orbitid/node` | Required token audience, if you set one. |
| `ORBITID_PUBLISHABLE_KEY` | no | `@orbitid/node` | A stand-in for `ORBITID_API_URL`: the server URL is read from it. |

## WEBSITE · BROWSER (public)

These are compiled into your site's client code, so everyone can read them. They contain no secrets: the publishable key only says which OrbitID instance to talk to. Next.js inlines variables that start with `NEXT_PUBLIC_`; other frameworks have their own prefix (`VITE_`, `PUBLIC_`) and the React SDK accepts the key as a prop.

| Variable | Required | Meaning |
| --- | --- | --- |
| `NEXT_PUBLIC_ORBITID_PUBLISHABLE_KEY` | **yes** | Publishable key (`pk_…`). The server prints it on start and the dashboard shows it. |
| `NEXT_PUBLIC_ORBITID_API_URL` | no | URL of your OrbitID server when it differs from the one in the key. |
| `NEXT_PUBLIC_ORBITID_SIGN_IN_URL` | no (`/sign-in`) | Where your sign-in page lives. |
| `NEXT_PUBLIC_ORBITID_SIGN_UP_URL` | no (`/sign-up`) | Where your sign-up page lives. |
| `NEXT_PUBLIC_ORBITID_AFTER_SIGN_IN_URL` | no (`/`) | Where users land after signing in. |
| `NEXT_PUBLIC_ORBITID_AFTER_SIGN_UP_URL` | no (`/`) | Where users land after signing up. |
| `VITE_ORBITID_API_URL` | no | API origin the dashboard bundle calls. Leave it empty: the dashboard is same-origin with the instance it serves, which its operator session cookie requires. Only a Vite development server sets it (with a matching proxy). See [DASHBOARD.md](DASHBOARD.md). |

## Which file does each label go in?

| What you run | SERVER | WEBSITE · BACKEND | WEBSITE · BROWSER |
| --- | --- | --- | --- |
| OrbitID in Docker | `.env` next to `docker-compose.yml` | – | – |
| Next.js app | – | `.env.local` (server only) | `.env.local` (`NEXT_PUBLIC_*`) |
| Express, Fastify, Hono | – | process environment or `.env` | – (the browser SDK takes the key as an option) |
| Single page app with the React SDK | – | on your API server | the build's public variables |

The same `.env.local` file can hold both website labels in Next.js, because Next.js decides what reaches the browser by the `NEXT_PUBLIC_` prefix. Keep the secret ones unprefixed.
