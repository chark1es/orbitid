# Self-hosting OrbitID

OrbitID is one Rust server process plus a Postgres database. The server exposes the API your apps call,
signs session tokens, and serves the admin dashboard at its root URL. Nothing else runs, and there is no
hosted service behind it. Outbound calls go to integrations you turn on (email and SMS providers, social
sign-in, CAPTCHA and the optional breached-password check) plus one release check to GitHub every 6 hours,
which carries no instance data and which `ORBITID_UPDATE_CHECK=false` turns off
([Version and update check](#version-and-update-check)).

## What you need

- A machine that can run Docker, or a Rust toolchain plus Bun and the SAML build libraries (see
  [Without Docker](#without-docker)).
- A Postgres database (version 14 or newer). SQLite and PGlite are not supported by this server.
- A public URL for the server if browsers other than your own will use it.

## Docker Compose (recommended)

```bash
cp .env.example .env
openssl rand -base64 32          # paste the output as ORBITID_ENCRYPTION_KEY in .env
openssl rand -hex 32             # paste the output as POSTGRES_PASSWORD in .env
docker compose up -d
docker compose logs orbitid      # prints the dashboard URL and your publishable key
```

Both `ORBITID_ENCRYPTION_KEY` and `POSTGRES_PASSWORD` are required: compose refuses to start until both are
set. Keep the Postgres password with the database volume; changing it needs a matching change inside Postgres.
Compose passes the database to the server as separate `ORBITID_DATABASE_HOST`/`_PORT`/`_USER`/`_PASSWORD`/`_NAME`
variables, never as a URL, so a password with `/`, `+` or `=` works too; `openssl rand -hex 32` is simply the
safest generator.

The compose file passes only the variables it lists (the ones in `.env.example`) into the container, so a
variable you add to `.env` has no effect until it is also listed under `environment:` in
`docker-compose.yml`. It starts Postgres 17 and OrbitID, runs the migrations on boot, and keeps the database
in a named volume. Open `http://localhost:4000`: on a fresh instance the dashboard asks you to create the owner
account, and that account opens the console from then on. The secret key is for your servers' Backend API
calls, not the dashboard. Startup never prints any part of it. Retrieve it explicitly with:

```bash
docker compose exec orbitid orbitid keys
```

The secret key is derived from `ORBITID_ENCRYPTION_KEY`, so it is the same after every restart. If you
override it with `ORBITID_SECRET_KEY`, production requires at least 32 random characters.

`ORBITID_PORT` in `.env` publishes the server on another host port. `ORBITID_BASE_URL` defaults to
`http://localhost:<ORBITID_PORT>`, so the two stay in step; set it explicitly when a proxy or public hostname
reaches the instance. `ORBITID_IMAGE` only sets the tag compose gives the image it builds. Because the
service has a `build:` section, compose builds this checkout; to run an image from a registry instead,
delete `build: .` from the `orbitid` service and set `ORBITID_IMAGE` to that image's tag.

The image is a minimal Debian bookworm-slim with the Rust binary, the built dashboard and only the shared
libraries SAML needs. It has no Node, no compiler and no curl. The container runs as the
unprivileged `orbitid` user (uid 10001), with a read-only root filesystem, every Linux capability dropped,
`no-new-privileges`, and only `/tmp` writable (a small tmpfs). There is **no application data volume**:
users, settings, signing keys and uploaded avatars/logos all live in Postgres. `ORBITID_DATA_DIR` defaults to
`/tmp/orbitid` only because startup creates that directory; it holds no deployment data.

To check a deployment the way CI does, run the smoke test. It builds the image, verifies its layout and
non-root uid, brings up the compose stack on Postgres, and walks health, readiness, the served dashboard, the
operator-session exchange, password sign-up and sign-in, an avatar upload, a restart, three replicas booting
concurrently against an empty database, and a two-replica scale-out. The scale-out proves that Caddy
distributes requests across replicas, that a session created through the load balancer is valid on every
replica, and that `ORBITID_TRUST_PROXY=1` reads the forwarded client address and scheme while Caddy replaces
spoofed values. Every container, volume, network and image it creates is named for that run and removed
afterwards:

```bash
bash scripts/smoke-container.sh
```

## Without Docker

Install the Rust toolchain from `rust-toolchain.toml` and the SAML build dependencies:

```bash
sudo apt-get install -y clang pkg-config libxml2-dev libxmlsec1-dev libssl-dev
bun install
bun run --filter @orbitid/dashboard build        # optional, lets the server host the dashboard
export ORBITID_DATABASE_URL=postgres://user:password@localhost:5432/orbitid
export ORBITID_ENCRYPTION_KEY="$(openssl rand -base64 32)"   # keep this value: it is needed on every start
export ORBITID_BASE_URL=https://auth.example.com          # the public URL browsers and your apps use
export NODE_ENV=production                                # turns on the production checks (the Docker image sets it)
cargo build --release -p orbitid-server
./target/release/orbitid start
```

`cargo run -p orbitid-server -- start` does the same during development. The binary's subcommands:

```text
orbitid start      Run migrations and start the server (default)
orbitid migrate    Run migrations and exit
orbitid keys       Print the publishable and secret keys and exit
orbitid export     Write a logical backup (JSON Lines)
orbitid import     Load a logical backup
orbitid copy       Copy one Postgres database into another
orbitid healthcheck  Probe http://127.0.0.1:$PORT/ready (exit 0 ready, 1 otherwise)
orbitid help       Show usage
```

## Configuration

Only infrastructure comes from environment variables. Everything about how sign-in behaves is an instance
setting that you edit in the dashboard.

The table below is the **SERVER** label: variables for the machine that runs OrbitID. Variables for your own
website (**WEBSITE · BACKEND** and **WEBSITE · BROWSER**) are in [ENVIRONMENT.md](ENVIRONMENT.md), which also
lists these in full.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ORBITID_DATABASE_URL` | none, **required** unless the parts are set | `postgres://…` or `postgresql://…`. `DATABASE_URL` also works. Any other scheme is refused. A URL password must be percent-encoded; the separate `ORBITID_DATABASE_HOST`, `_PORT`, `_USER`, `_PASSWORD`, `_NAME` (or `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`) need no encoding and are used when no URL is set. See [ENVIRONMENT.md](ENVIRONMENT.md). |
| `ORBITID_DB_MAX_CONNECTIONS` | `20` | Maximum pooled Postgres connections per replica. Each replica also opens one dedicated `LISTEN` connection for settings changes, so keep `replicas × (this + 1)` below Postgres's `max_connections`. |
| `ORBITID_DB_ACQUIRE_TIMEOUT_MS` | `30000` | How long a request waits for a pooled connection before failing. |
| `ORBITID_REQUEST_TIMEOUT_MS` | `30000` | Handler deadline; `0` disables it. |
| `ORBITID_DRAIN_TIMEOUT_MS` | `10000` | Graceful-shutdown drain deadline after SIGTERM. |
| `ORBITID_DASHBOARD_CONNECT_SRC` | none | Extra dashboard CSP `connect-src` origin when the API is on another host. |
| `ORBITID_WEBHOOK_RETENTION_DAYS` | `30` | Terminal webhook deliveries and their events are deleted after this many days (`0` keeps forever). |
| `ORBITID_AUDIT_RETENTION_DAYS` | `0` | Audit rows older than this many days are deleted; `0` keeps them forever (the default). |
| `ORBITID_ENCRYPTION_KEY` | none, required with Postgres | At least 32 characters. Encrypts signing keys, TOTP secrets and OAuth tokens in the database. Keep it identical across restarts and restores: a changed key cannot decrypt the stored signing keys, so startup refuses with an explicit error instead of generating new keys (which would sign every user out). |
| `ORBITID_BASE_URL` | `http://localhost:<port>` | The URL browsers and your apps use to reach the server. It is the token issuer. |
| `ORBITID_SECRET_KEY` | derived | Backend API key. When unset it is derived from the encryption key, so it stays the same across restarts and rebuilds. |
| `PORT` | `4000` | Port to listen on. |
| `ORBITID_DATA_DIR` | `./data` | A writable directory created at boot. Uploads are in Postgres, so it holds no deployment data. The image uses `/tmp/orbitid`. |
| `ORBITID_DASHBOARD_DIR` | built dashboard next to the server | Folder holding the built dashboard. The image uses `/app/dashboard`. |
| `ORBITID_TRUST_PROXY` | `0` | Number of reverse proxies in front of the server. Rate limits and session records use the socket address unless this is set; with `1` they use the last `X-Forwarded-For` entry. Set it only when a proxy you run sets that header. |
| `ORBITID_ALLOW_PRIVATE_NETWORKS` | `false` | Let webhooks and identity providers reach private addresses. Development mode allows them anyway. |
| `ORBITID_PORT` | `4000` | Compose only. Host port to publish; `ORBITID_BASE_URL` defaults to it. |
| `ORBITID_IMAGE` | `orbitid:local` | Compose only. Tag given to the image compose builds. |
| `POSTGRES_PASSWORD` | none, **required in compose** | Compose only. Password of the bundled Postgres container; compose refuses to start until it is set. Use `openssl rand -hex 32`. |

## Health and readiness

- `GET /health` is liveness: `{status, publishable_key, database: "postgres", database_driver: "postgres"}`.
  It needs no key and no database round trip.
- `GET /ready` checks the database and answers non-2xx while Postgres is unreachable. Point load-balancer
  readiness probes and orchestrator startup probes at it; keep `/health` for liveness. The image and the
  compose file use `orbitid healthcheck`, which probes `/ready` on `$PORT` and exits 0 or 1.

## First steps in the dashboard

Until you configure a delivery provider, saves that leave an email/SMS-dependent authentication flow enabled
are refused. Configure delivery first, or explicitly disable all delivery-dependent factors and sign-up
verification in one settings update. The smoke script uses the latter only for its throwaway test instance.

1. Open the dashboard and create the owner account (the first visitor of a fresh instance does this, so do it
   before exposing the instance). The dashboard keeps only a revocable httpOnly session tied to that account. On
   an instance whose accounts predate owners, grant one with `orbitid owner you@example.com` on the server; see
   [DASHBOARD.md](DASHBOARD.md#accounts-owners-and-administrators).
2. Under **Email & SMS**, configure Resend or SMTP and send a test email before enabling an email-dependent
   flow. Configure Twilio or an HTTPS webhook before enabling phone verification or sign-in. See
   [EMAIL.md](EMAIL.md).
3. Under Appearance, add the origin of each app that will call OrbitID, for example
   `https://app.example.com`. A new production instance trusts no origins until you do.
4. Under **Authentication**, choose identifiers and methods. Saves with missing delivery/provider
   prerequisites are refused. Passwords and other methods that do not require delivery can be tested without
   email verification.
5. Open **Connect your app**: it prints copy-ready blocks, labelled by where they go. The publishable key goes
   into your website's browser environment and the secret key into its backend environment
   ([ENVIRONMENT.md](ENVIRONMENT.md)).

## Upgrading

Pull the new image or code and restart. The server applies pending migrations before it starts listening.
Back up the database first.

What happens on boot, which is what makes an unattended image update safe:

- Migrations run before the port opens, so `/ready` and `orbitid healthcheck` only pass once the schema is
  current. Each migration runs in its own transaction (the few `CREATE INDEX CONCURRENTLY` ones cannot, and an
  interrupted build of those is dropped and rebuilt on the next boot), so a failed migration leaves the
  database as it was and the server exits instead of serving a half-migrated schema.
- The whole startup sequence holds one Postgres advisory lock. Several replicas restarting onto a new image at
  once are serialised: one migrates, the others wait and find nothing to do.
- Migrations only move forward. An older image refuses to start against a database a newer image has already
  migrated (sqlx reports the applied migration it does not know), rather than run against a schema it does not
  understand. Rolling back across a migration therefore means restoring the backup taken before the update.

### Version and update check

The running version is printed at startup (`Version : …`) and returned by `GET /v1/instance` as
`version.current`. Every 6 hours each replica asks
`https://api.github.com/repos/chark1es/orbitid/releases/latest` for the newest published release and keeps
the answer in memory; when it is newer by semver, the dashboard's top bar shows **Update available** with a
link to the release notes, and the log says so. Nothing is shown while the instance is current.

The request is an unauthenticated `GET` with the `orbitid/<version>` user agent. It sends no keys, URLs,
counts or other instance data. If GitHub cannot be reached (offline, firewalled, rate limited) the check
retries an hour later, keeps the last answer and logs only at `debug`. It is on by default because an
authentication server that falls behind on security fixes is the larger risk; set `ORBITID_UPDATE_CHECK=false`
to make no request at all (see [ENVIRONMENT.md](ENVIRONMENT.md)). The check only reports: it never downloads
or installs anything.

### Image tags and pinning

Release images are published as `ghcr.io/chark1es/orbitid` with four kinds of tag:

| Tag | Moves to | Use it for |
| --- | --- | --- |
| `1.4.2` (`X.Y.Z`) | never moves | Production you upgrade by hand. Reproducible: every restart runs the same build. |
| `1.4` (`X.Y`) | the newest patch release of 1.4 | Unattended updates that take only bug and security fixes. |
| `1` (`X`) | the newest 1.x release | Unattended updates that also take new features. Breaking changes only arrive with a new major version. |
| `latest` | the newest release of any major version | Trying OrbitID out. Do not auto-update production on it: it crosses major versions. |

While OrbitID is below 1.0, semver allows breaking changes in a minor release, so pin unattended updates to
`0.Y` rather than `0`. The update indicator still announces a newer major (or minor, for `0.Y`) release that a
pinned tag will not pick up; that upgrade is a deliberate, manual step.

To run a published image with the bundled compose file, remove `build: .` from the `orbitid` service and set
`ORBITID_IMAGE=ghcr.io/chark1es/orbitid:1.4.2` (or the tag you chose) in `.env`.

### Automatic updates (opt-in)

OrbitID never replaces itself. To update unattended, let something outside the container pull a pinned tag and
recreate the container; the boot sequence above then migrates safely. Before turning this on, schedule
database backups ([Backups](#backups)): a backup is the only way back across a migration.

The simplest form needs no extra container. A cron entry or systemd timer on the Docker host, in the
directory with `docker-compose.yml`:

```bash
# Daily at 04:00, with ORBITID_IMAGE=ghcr.io/chark1es/orbitid:1 (or 0.Y) in .env and no `build:` section.
docker compose pull orbitid && docker compose up -d orbitid
```

`up -d` recreates the container only when the pull fetched a new image. Compose stops the old container
first (`stop_grace_period: 30s`, so in-flight requests drain), and the healthcheck reports the new one once it
has migrated and is listening.

[`docker-compose.autoupdate.yml`](../docker-compose.autoupdate.yml) is the same thing as a compose overlay
using [Watchtower](https://containrrr.dev/watchtower/), for hosts where a timer is not convenient. It runs
the published image on the tag in `ORBITID_AUTOUPDATE_TAG` and lets Watchtower update only the OrbitID
container, daily at 04:00 (`WATCHTOWER_SCHEDULE` changes that):

```bash
echo 'ORBITID_AUTOUPDATE_TAG=0.1' >> .env   # or 1, 1.4, … — never latest
docker compose -f docker-compose.yml -f docker-compose.autoupdate.yml up -d
```

It needs Docker Compose 2.24 or newer (it removes the base file's `build:` with `!reset`). Watchtower reads
the Docker socket, which is equivalent to root on the host; prefer the timer when that matters. Neither form
rolls back on its own: if a new release fails to boot, the old container is already gone, so pin the previous
`X.Y.Z` tag, and restore the backup if the failed release had migrated the database.

Migration `0010` builds the verified-domain index with `CREATE INDEX CONCURRENTLY` (a non-transactional
migration), so a large `email_addresses` table keeps accepting writes while it is indexed; the build can take a
while on a big table. If a build was interrupted, the invalid leftover index is dropped automatically on the next
boot and rebuilt. Migration `0011` is metadata only (two columns on `organization_domains`, a small
`worker_cursors` table) and is instant. Domains verified before the upgrade are not re-enrolled automatically;
switch the mode off and on again to run an enrollment pass. Migration `0012` adds three nullable columns on
`organization_domains` (instant).

**A stuck enrollment domain.** If an enrollment chunk keeps failing, the worker backs off (30 s, doubling, at most
1 h between attempts), logs each failure at `error` with the domain id and never discards a membership. To see
stuck domains: `SELECT id, enrollment_failures, enrollment_last_error, enrollment_next_attempt_at FROM
organization_domains WHERE enrollment_failures > 0;`. Fix the cause (usually the webhook outbox or a database
constraint); the next attempt after `enrollment_next_attempt_at` completes the pass and resets the counters.

### Upgrading from the TypeScript server

The rewrite keeps the same tables and the same HTTP contract. A Postgres database created by the TypeScript
server is adopted in place: point the new binary at the same `ORBITID_DATABASE_URL`, keep the same
`ORBITID_ENCRYPTION_KEY`, and start it. The migration ledger is baselined from `drizzle.__drizzle_migrations`;
a database behind the last drizzle migration is refused with an actionable message rather than half-migrated.

SQLite and PGlite instances must move to Postgres first, with the **last TypeScript release** (the Rust
server cannot read those files):

```bash
# Still on the TypeScript release, with the old SQLite file:
orbitid copy --from sqlite:/srv/orbitid/orbitid.db --to postgres://orbitid@db.internal/orbitid

# Then switch ORBITID_DATABASE_URL to that Postgres URL and run the Rust server.
```

Uploaded images made by the TypeScript server live on disk under `ORBITID_DATA_DIR/uploads` (avatars) and
`ORBITID_DATA_DIR/uploads/orgs` (logos); the Rust server serves the same public URLs from Postgres. Import
the old files once, before or after switching, so existing `image_url`/`logo_url` values keep resolving:

```bash
ORBITID_DATABASE_URL=postgres://orbitid@db.internal/orbitid \
ORBITID_ENCRYPTION_KEY=… orbitid import-uploads --from /srv/orbitid/data
```

The command keeps each file's public name, validates that it is a real PNG/JPEG/GIF/WebP, skips files that
are already present, never follows symlinks, and prints how many files it imported and skipped. Running it
again is safe. Full procedure, including a live Postgres move: [DATA_MOVE.md](DATA_MOVE.md).

## Backups

Everything lives in the database, including uploaded profile images and organization logos. Back it up with
`pg_dump` (or your provider's snapshot) and keep a copy of `ORBITID_ENCRYPTION_KEY` (and
`ORBITID_SECRET_KEY` if you set one) somewhere safe. A restore with a different encryption key cannot read the
stored signing keys, TOTP secrets or OAuth tokens, and the server fails at startup with an error naming
`ORBITID_ENCRYPTION_KEY`; it never silently mints replacement signing keys. Signing keys live in the database
and old public keys stay in the JWKS after a rotation, so outstanding session tokens keep verifying.

`orbitid export` writes a portable logical backup and `orbitid import` restores it; see
[DATA_MOVE.md](DATA_MOVE.md).

## Behind a reverse proxy

Set `ORBITID_BASE_URL` to the public URL, terminate TLS at the proxy, and set `ORBITID_TRUST_PROXY=1` so rate
limits and session records see the client address instead of the proxy's, and so the session cookies' `Secure`
attribute follows the proxy's `X-Forwarded-Proto: https`. Do not set it when the server is reachable without a
proxy: clients could then choose their own address and scheme. Cross-site POST callbacks (SAML, Apple sign-in)
need an `https` base URL. A plain-http localhost instance keeps working: the `__client` cookie simply omits
`Secure` because the browser would refuse it.

**A TLS-terminating proxy also needs an `https://` `ORBITID_BASE_URL`.** The dashboard's operator-session
cookie derives `Secure` from `ORBITID_BASE_URL` alone, not from `X-Forwarded-Proto`, so a deployment that
terminates TLS at the proxy but keeps `ORBITID_BASE_URL` on plain `http://` serves that cookie without
`Secure`. The server logs a startup warning for exactly that combination (`ORBITID_TRUST_PROXY` set, plain
`http://` base URL on a non-local host).

## Retention and housekeeping

Every replica runs the same bounded, advisory-locked sweeps; only one sweeps at a time, and a backlog is
worked off over several hourly ticks. Expired verifications, OAuth/SAML state, device codes, abandoned
attempts, long-ended sessions and orphaned clients are swept automatically (see `crates/README.md`).
`ORBITID_WEBHOOK_RETENTION_DAYS` (default 30) removes terminal webhook deliveries and events whose deliveries
are all terminal. `ORBITID_AUDIT_RETENTION_DAYS` defaults to `0`, which keeps audit logs forever; set a
positive number only when your compliance policy allows deleting old audit rows. Upload rows that no user or
organization points at are removed after a 24-hour grace period, which also cleans up rows orphaned before
the Rust server managed uploads.

## Horizontal scaling

The server is stateless. Run as many replicas as you need behind a load balancer, all pointed at the same
Postgres database:

- Sessions, settings, signing keys, rate-limit windows and uploads are in Postgres, so any replica can answer
  any request.
- Concurrent first boots are safe. The `instance` settings row is created with
  `INSERT … ON CONFLICT DO NOTHING`, and every settings write locks that row, merges the patch onto the
  database value, validates and commits in one transaction. Two replicas editing different fields therefore
  both persist; no configuration is lost.
- Settings changes propagate over Postgres `LISTEN/NOTIFY`; every replica refreshes within 30 s even if a
  notification is missed. The notification carries the revision of the write, and publication is ordered
  by a database-assigned revision counter that the row-locked `UPDATE` increments, so replicas converge
  on the committed value even when their clocks are not synchronised.
- Webhook retries and cleanup workers take database locks, so work is not duplicated across replicas. A
  delivery is claimed with a lease just before it is sent, rows are sent in bounded parallel batches, and the
  result is written only if the worker still owns that lease.
- Set `ORBITID_TRUST_PROXY=1` behind one proxy and `ORBITID_BASE_URL` to the public `https://` address (also
  needed for the dashboard cookie's `Secure` attribute). Use `/ready` for readiness probes.
- Every replica opens `ORBITID_DB_MAX_CONNECTIONS` pooled connections plus one dedicated `LISTEN`
  connection for settings changes. Keep `replicas × (ORBITID_DB_MAX_CONNECTIONS + 1)` below Postgres's
  `max_connections`; lower the per-replica pool when you add replicas rather than raising Postgres alone.
  The bundled `docker-compose.yml` sets `max_connections=300`, which fits its documented three-replica
  scale-out and the five-replica `--scale orbitid=5` example (105 connections).

[`docker-compose.scale.yml`](../docker-compose.scale.yml) runs three replicas behind Caddy:

```bash
docker compose -f docker-compose.yml -f docker-compose.scale.yml up -d
# or choose the count yourself:
docker compose -f docker-compose.yml -f docker-compose.scale.yml up -d --scale orbitid=5
```

Caddy uses dynamic upstreams (`dynamic a`, Caddy 2.10+): it refreshes the replica address list from Docker DNS
every 5 seconds and round-robins across every replica. Compose starts Caddy only after every replica is
healthy. Caddy does not run active health checks against dynamic upstreams, so the proxy also retries failed
connections and passively removes a replica that answers 503 from `/ready`; it returns to the pool on the next
DNS refresh once it is ready again. Responses do not reveal which replica handled a request: the shipped
configuration adds no upstream header or internal address. To confirm distribution, read each replica's
request log (every server logs one line per request); the container smoke test does exactly that.

## What the container check does and does not prove

`scripts/smoke-container.sh` runs the real Rust image on Postgres. It proves the image builds without Node,
that every shared library `ldd` needs is present, that the server runs as uid 10001 with a read-only `/app`,
and that health, readiness, the dashboard, password-based sign-up with email verification disabled on the
throwaway smoke instance, password sign-in, uploads, the operator-session key exchange, concurrent first
boot, multi-replica load balancing and a shared session all work — including across a restart.

Some things need infrastructure or hardware it does not have, so they stay unverified here:

- **Social sign-in** is exercised against a stand-in provider, not a live one. No run in CI contacts Google,
  GitHub or any other provider, because that needs registered applications, real client secrets and redirect
  URIs owned by whoever deploys. Before relying on a provider, turn it on in the dashboard with your own
  credentials and sign in once.
- **Passkeys** are exercised with a software authenticator, not a hardware one. The ceremonies (registration,
  authentication, discoverable credentials, origin and RP ID checks, failure cases) run end to end over HTTP.
  No physical security key or platform authenticator is present. The RP ID follows the origin the browser
  reports, so check passkeys on the domain you actually serve before enabling them for users.
- **Email and SMS** delivery is not exercised by the container smoke script. Unit/integration suites use local
  stand-ins. Real Resend, SMTP and Twilio accounts are not used.
- **Enterprise SAML** is covered against test identity providers, not a live one.

The fixtures cannot prove compatibility with a live service or a physical authenticator. Verify the providers,
delivery services and authenticators you plan to enable against your deployment's domain and configuration.
