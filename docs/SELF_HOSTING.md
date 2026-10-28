# Self-hosting OrbitID

OrbitID is one server process plus a database. The server exposes the API your apps call, signs session tokens, and serves the admin dashboard at its root URL. Nothing else runs, and nothing contacts a hosted service.

## What you need

- A machine that can run Docker, or Node 20 and Bun.
- A Postgres database (version 14 or newer). SQLite works for trying things out.
- A public URL for the server if browsers other than your own will use it.

## Docker Compose (recommended)

```bash
cp .env.example .env
openssl rand -base64 32          # paste the output as ORBITID_ENCRYPTION_KEY in .env
docker compose up -d
docker compose logs orbitid      # prints your keys and the dashboard URL
```

The compose file starts Postgres 17 and OrbitID, runs the migrations on boot, and keeps data in two named volumes. Open `http://localhost:4000`, paste the secret key from the log, and you are in the dashboard.

To print the keys again at any time:

```bash
docker compose exec orbitid node_modules/.bin/tsx packages/server/src/cli.ts keys
```

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

## First steps in the dashboard

1. Open the dashboard and sign in with the secret key.
2. Under Authentication, choose the identifiers and sign-in methods you want.
3. Under Appearance, add the origin of each app that will call OrbitID, for example `https://app.example.com`. A new production instance trusts no origins until you do.
4. Under Email and SMS, add an SMTP URL. Until then codes and links are printed in the server log.
5. Copy the publishable key into your app's frontend environment and the secret key into its backend environment.

## Moving from SQLite to Postgres

The two databases use the same tables and the same migrations history of their own. There is no automatic data copy. For an instance with real users, export users with the Backend API (`GET /v1/users`) and create them on the new instance with `POST /v1/users`, which accepts password digests.

## Upgrading

Pull the new image or code and restart. The server applies pending migrations before it starts listening. Back up the database first.

## Backups

Everything lives in the database, plus uploaded profile images and organization logos under `ORBITID_DATA_DIR/uploads`. Back up both.

## Behind a reverse proxy

Set `ORBITID_BASE_URL` to the public URL, terminate TLS at the proxy, and forward `X-Forwarded-For` so session records show the client address. Cross-site POST callbacks (SAML, Apple sign-in) need an `https` base URL.
