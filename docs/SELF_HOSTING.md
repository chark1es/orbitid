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

The compose file starts Postgres 17 and OrbitID, runs the migrations on boot, and keeps data in two named volumes. Open `http://localhost:4000` and sign in to the dashboard with the secret key. A production instance shows only the end of the secret key in its log; print the whole key with:

```bash
docker compose exec orbitid node_modules/.bin/tsx packages/server/src/cli.ts keys
```

The secret key is derived from `ORBITID_ENCRYPTION_KEY`, so it is the same after every restart.

## Without Docker

```bash
bun install
bun run --filter @orbitid/dashboard build        # optional, lets the server host the dashboard
export ORBITID_DATABASE_URL=postgres://user:password@localhost:5432/orbitid
export ORBITID_ENCRYPTION_KEY="$(openssl rand -base64 32)"
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

## First steps in the dashboard

1. Open the dashboard and sign in with the secret key.
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
