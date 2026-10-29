# Environment variables

Three different programs read environment variables, and each one needs a different set. Every variable below carries one of these labels, and `.env.example` files in the repo use the same labels.

| Label | Where it is set | Who can see it |
| --- | --- | --- |
| **SERVER** | The machine or container that runs OrbitID | Only you |
| **WEBSITE · BACKEND (secret)** | The server side of the website or API that uses OrbitID (Next.js server, Express, a worker) | Only you. Never ship it to a browser |
| **WEBSITE · BROWSER (public)** | Your website's build, where the framework inlines it into client code | Everyone who loads the site |

Rule of thumb: a value that can read or change users (the secret key, the encryption key, an email provider key) never goes under BROWSER. The dashboard's **Connect your app** page prints copy-ready blocks for each label from your running instance.

## SERVER

Set these where OrbitID runs: the container environment, `docker compose`'s `.env`, or the shell that starts `orbitid`. Nothing here belongs in a website.

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `ORBITID_ENCRYPTION_KEY` | **yes** (always with Postgres or a public base URL) | none | At least 32 characters. Encrypts signing keys, TOTP secrets, OAuth tokens and stored provider secrets, and derives the secret key. Keep it stable and backed up; changing it makes stored secrets unreadable. |
| `ORBITID_DATABASE_URL` | recommended | SQLite file in the data dir | `postgres://…`, `pglite://<dir>` or `sqlite:<file>`. `DATABASE_URL` also works. |
| `ORBITID_BASE_URL` | yes in production | `http://localhost:<port>` | The URL browsers and your apps use to reach the server. It is the token issuer. |
| `PORT` / `ORBITID_PORT` | no | `4000` | Port to listen on. |
| `ORBITID_SECRET_KEY` | no | derived from the encryption key | Backend API key. Set it only to pin a specific value. |
| `ORBITID_DATABASE_PATH` | no | none | Legacy alias: a SQLite file path, used when `ORBITID_DATABASE_URL` is not set. |
| `ORBITID_DATA_DIR` | no | `./data` | Uploads and, for SQLite, the database file. |
| `ORBITID_DASHBOARD_DIR` | no | built dashboard next to the server | Folder holding the built dashboard. |
| `ORBITID_DATABASE_POOL` | no | `10` | Maximum Postgres connections. |
| `ORBITID_DB_DIALECT` | no | from the URL | Force `postgres` or `sqlite`. |
| `ORBITID_TRUST_PROXY` | no | `0` | Number of reverse proxies in front of the server. See [SELF_HOSTING.md](SELF_HOSTING.md). |
| `ORBITID_ALLOW_PRIVATE_NETWORKS` | no | `false` | Let outbound calls (webhooks, identity providers) reach private addresses. Development mode allows them anyway. See [SECURITY.md](SECURITY.md). |
| `ORBITID_DASHBOARD_CONNECT_SRC` | no | none | Extra origins the dashboard may call, when its API lives elsewhere. See [SECURITY.md](SECURITY.md). |
| `ORBITID_RESEND_API_KEY` | no | none | Send email through Resend. See [EMAIL.md](EMAIL.md). |
| `ORBITID_SMTP_URL` | no | none | Send email through SMTP, `smtps://user:password@host:465`. |
| `ORBITID_ALLOW_CONSOLE_EMAIL` | no | `false` | Production only. Lets the console transport print email, codes and links included, to the server log. For a trial run, never for real users. See [EMAIL.md](EMAIL.md). |
| `ORBITID_EMAIL_FROM` | no | `OrbitID <no-reply@localhost>` | From address for all email. |
| `NODE_ENV` | no | `development` | Set to `production` in deployments (the Docker image does). Turns on production checks. |
| `POSTGRES_PASSWORD` | docker compose only | `orbitid` | Password of the bundled Postgres container. |

Everything else about how sign-in behaves (identifiers, password rules, providers, MFA, sessions, organizations, branding) is an instance setting edited in the dashboard, not an environment variable. Email settings can live in either place; an environment value fills in when the dashboard setting is empty.

## WEBSITE · BACKEND (secret)

Set these on the server side of your own app: the Next.js server, an Express or Fastify process, a worker. They authorize calls to the Backend API and verify tokens. Never expose them to the browser, and never prefix them with `NEXT_PUBLIC_`.

| Variable | Required | Read by | Meaning |
| --- | --- | --- | --- |
| `ORBITID_SECRET_KEY` | **yes** | `@orbitid/nextjs`, `@orbitid/node`, `@orbitid/backend` | Backend API key (`sk_…`). Print it with `orbitid keys` or copy it from the dashboard. |
| `ORBITID_API_URL` | **yes**, unless a publishable key is given | `@orbitid/node`, `@orbitid/backend` | URL of your OrbitID server (`https://auth.example.com`). There is no hosted default, so the SDK refuses to start without it (or `ORBITID_PUBLISHABLE_KEY`, which carries the URL). |
| `ORBITID_WEBHOOK_SECRET` | only to receive webhooks | all backend SDKs | Signing secret (`whsec_…`) of the webhook endpoint you registered in the dashboard. |
| `ORBITID_JWT_KEY` | no | `@orbitid/nextjs` | PEM public key to verify session tokens without fetching the key set. |
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
| `VITE_ORBITID_API_URL` | no | Build-time API URL for the OrbitID dashboard when it is served from a different origin than the server. The dashboard bundle ships to browsers, so this is public. See [DASHBOARD.md](DASHBOARD.md). |

## Which file does each label go in?

| What you run | SERVER | WEBSITE · BACKEND | WEBSITE · BROWSER |
| --- | --- | --- | --- |
| OrbitID in Docker | `.env` next to `docker-compose.yml` | – | – |
| Next.js app | – | `.env.local` (server only) | `.env.local` (`NEXT_PUBLIC_*`) |
| Express, Fastify, Hono | – | process environment or `.env` | – (the browser SDK takes the key as an option) |
| Single page app with the React SDK | – | on your API server | the build's public variables |

The same `.env.local` file can hold both website labels in Next.js, because Next.js decides what reaches the browser by the `NEXT_PUBLIC_` prefix. Keep the secret ones unprefixed.
