# Self-hosting OrbitID

OrbitID is one server process plus a database. The server exposes the API your apps call, signs session tokens, and serves the admin dashboard at its root URL. Nothing else runs, and there is no hosted service behind it. The only outbound calls are to integrations you turn on: email and SMS providers, social sign-in, CAPTCHA and the optional breached-password check.

## What you need

- A machine that can run Docker, or Node 20 and Bun.
- A Postgres database (version 14 or newer). SQLite works for trying things out.
- A public URL for the server if browsers other than your own will use it.

## Docker Compose (recommended)

```bash
cp .env.example .env
openssl rand -base64 32          # paste the output as ORBITID_ENCRYPTION_KEY in .env
docker compose up -d
docker compose logs orbitid      # prints the dashboard URL and your publishable key
```

The compose file passes only the variables it lists (the ones in `.env.example`) into the container, so a variable you add to `.env` has no effect until it is also listed under `environment:` in `docker-compose.yml`. It starts Postgres 17 and OrbitID, runs the migrations on boot, and keeps data in two named volumes. Open `http://localhost:4000` and sign in to the dashboard with the secret key; it is exchanged once for an httpOnly session cookie stored in your database. A production instance shows only the end of the secret key in its log; print the whole key with:

```bash
docker compose exec orbitid node node_modules/tsx/dist/cli.mjs packages/server/src/cli.ts keys
```

The secret key is derived from `ORBITID_ENCRYPTION_KEY`, so it is the same after every restart.

`ORBITID_PORT` in `.env` publishes the server on another host port. `ORBITID_BASE_URL` defaults to `http://localhost:<ORBITID_PORT>`, so the two stay in step; set it explicitly when a proxy or public hostname reaches the instance. `ORBITID_IMAGE` only sets the tag compose gives the image it builds. Because the service has a `build:` section, compose builds this checkout; to run an image from a registry instead, delete `build: .` from the `orbitid` service and set `ORBITID_IMAGE` to that image's tag.

The container is hardened: it runs as the unprivileged `node` user (uid 1000), with a read-only root filesystem, every Linux capability dropped, `no-new-privileges`, and only the `/data` volume writable. Nothing in the image runs as root after startup, and `/app` is read-only. The TypeScript runner unpacks a small loader into `TMPDIR`, which the image points at `/data/tmp` inside the data volume, so no writable `/tmp` is needed and `docker compose exec orbitid … keys` works too. Compose adds a small `/tmp` tmpfs as well; it is an optimisation, not a requirement.

To check a deployment the way CI does, run the smoke test. It builds the image, proves the native modules load on Node 20, starts the SQLite container, brings up the compose stack on Postgres, and walks the dashboard sign-in, sign-up, sign-in and restart paths. Every container, volume, network and image it creates is named for that run and removed afterwards:

```bash
bash scripts/smoke-container.sh
```

## Without Docker

```bash
bun install
bun run --filter @orbitid/dashboard build        # optional, lets the server host the dashboard
export ORBITID_DATABASE_URL=postgres://user:password@localhost:5432/orbitid
export ORBITID_ENCRYPTION_KEY="$(openssl rand -base64 32)"   # keep this value: it is needed on every start
export ORBITID_BASE_URL=https://auth.example.com          # the public URL browsers and your apps use
export NODE_ENV=production                                # turns on the production checks (the Docker image sets it)
node_modules/.bin/tsx packages/server/src/cli.ts start
```

With no `ORBITID_DATABASE_URL` the server uses a SQLite file at `./data/orbitid.db` and says so on startup. That is fine for development. Use Postgres for anything real.

## Configuration

Only infrastructure comes from environment variables. Everything about how sign-in behaves is an instance setting that you edit in the dashboard.

The table below is the **SERVER** label: variables for the machine that runs OrbitID. Variables for your own website (**WEBSITE · BACKEND** and **WEBSITE · BROWSER**) are in [ENVIRONMENT.md](ENVIRONMENT.md), which also lists these in full.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ORBITID_DATABASE_URL` | SQLite file in the data dir | `postgres://…`, `pglite://<dir>` or `sqlite:<file>`. `DATABASE_URL` also works. |
| `ORBITID_ENCRYPTION_KEY` | none, required in production | At least 32 characters. Encrypts signing keys, TOTP secrets and OAuth tokens in the database. Changing it makes them unreadable. |
| `ORBITID_BASE_URL` | `http://localhost:<port>` | The URL browsers and your apps use to reach the server. It is the token issuer. |
| `ORBITID_SECRET_KEY` | derived | Backend API key. When unset it is derived from the encryption key, so it stays the same across restarts and rebuilds. |
| `PORT` | `4000` | Port to listen on. |
| `ORBITID_DATA_DIR` | `./data` | Uploads and, for SQLite, the database file. |
| `ORBITID_DASHBOARD_DIR` | built dashboard next to the server | Folder holding the built dashboard. |
| `ORBITID_DATABASE_POOL` | `10` | Maximum Postgres connections. |
| `ORBITID_TRUST_PROXY` | `0` | Number of reverse proxies in front of the server. Rate limits and session records use the socket address unless this is set; with `1` they use the last `X-Forwarded-For` entry. Set it only when a proxy you run sets that header. |
| `ORBITID_PORT` | `4000` | Compose only. Host port to publish; `ORBITID_BASE_URL` defaults to it. |
| `ORBITID_IMAGE` | `orbitid:local` | Compose only. Tag given to the image compose builds. Compose builds whenever `build:` is present, so to run an image from a registry instead, remove `build:` from `docker-compose.yml` and set this to that tag. |

## First steps in the dashboard

1. Open the dashboard and sign in with the secret key. The dashboard keeps only a revocable httpOnly session, and signs out when you rotate the key.
2. Under Authentication, choose the identifiers and sign-in methods you want.
3. Under Appearance, add the origin of each app that will call OrbitID, for example `https://app.example.com`. A new production instance trusts no origins until you do.
4. Under Email and SMS, choose Resend or SMTP (or set `ORBITID_RESEND_API_KEY` / `ORBITID_SMTP_URL` for the server) and send a test email. Until then a production instance cannot send email (sign-in codes and links are not delivered, and nothing is printed to the log). To trial it anyway, set `ORBITID_ALLOW_CONSOLE_EMAIL=true`. See [EMAIL.md](EMAIL.md).
5. Open **Connect your app**: it prints copy-ready blocks, labelled by where they go. The publishable key goes into your website's browser environment and the secret key into its backend environment ([ENVIRONMENT.md](ENVIRONMENT.md)).

## Moving between SQLite and Postgres

`orbitid copy --from <url> --to <url>` moves everything (users with their passwords, MFA, passkeys, sessions, organizations, keys, webhooks, audit logs) and checks the row counts at the end. `export` and `import` do the same in two steps, which also makes them a backup and restore. Uploaded images are not part of the export; copy the uploads folder yourself. Step by step, with the downtime procedure: [DATA_MOVE.md](DATA_MOVE.md).

## Upgrading

Pull the new image or code and restart. The server applies pending migrations before it starts listening. Back up the database first.

## Backups

Everything lives in the database, plus uploaded profile images and organization logos under `ORBITID_DATA_DIR/uploads`. Back up both, and keep a copy of `ORBITID_ENCRYPTION_KEY` (and `ORBITID_SECRET_KEY` if you set one) somewhere safe. A restore with a different encryption key cannot read the stored signing keys, TOTP secrets or OAuth tokens. A development instance without a key also needs `ORBITID_DATA_DIR/keys.json`.

## Behind a reverse proxy

Set `ORBITID_BASE_URL` to the public URL, terminate TLS at the proxy, and set `ORBITID_TRUST_PROXY=1` so rate limits and session records see the client address instead of the proxy's. Do not set it when the server is reachable without a proxy: clients could then choose their own address. Cross-site POST callbacks (SAML, Apple sign-in) need an `https` base URL.

## What the container check does and does not prove

`scripts/smoke-container.sh` runs the real image on both databases. It proves the image builds, that `better-sqlite3` and `@node-rs/argon2` load on the image's Node 20 ABI, that the server runs as uid 1000 with a read-only `/app`, and that health, the dashboard, sign-up with an email code, password sign-in and the operator-session key exchange all work — including across a restart and a fresh container on the same volume.

Some things need infrastructure or hardware it does not have, so they stay unverified here:

- **Social sign-in** is exercised against a stand-in provider, not a live one. The suite drives the full OAuth flow with a fake adapter, so authorization URLs, state/PKCE handling, code exchange, profile mapping, linking and error paths are covered. No run in CI contacts Google, GitHub or any other provider, because that needs registered applications, real client secrets and redirect URIs owned by whoever deploys. Before relying on a provider, turn it on in the dashboard with your own credentials and sign in once.
- **Passkeys** are exercised with a software authenticator, not a hardware one. The ceremonies (registration, authentication, discoverable credentials, origin and RP ID checks, failure cases) run end to end over HTTP. No physical security key or platform authenticator is present, so device-specific behaviour — a key that requires a PIN, an authenticator that rejects the RP ID your domain uses, cross-device flows — is untested here. The RP ID follows the origin the browser reports, so check passkeys on the domain you actually serve before enabling them for users.
- **Email and SMS** are verified with local stand-ins and the console transport. Real Resend, SMTP and Twilio accounts are not used.
- **Enterprise SAML** is covered against test identity providers, not a live one.

The fixtures cannot prove compatibility with a live service or a physical authenticator. Verify the providers,
delivery services and authenticators you plan to enable against your deployment's domain and configuration.
