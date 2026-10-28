# example-node

A plain Node server — `node:http` only, no framework — that uses `@orbitid/node` for session
verification, a permission check, webhook verification and a Backend API script.

## Run

```bash
# terminal 1 — OrbitID server (from the repo root)
bun run dev:server

# terminal 2 — this app
cd apps/example-node
cp .env.example .env          # fill in ORBITID_SECRET_KEY (and the webhook secret)
bun run dev
```

`bun run start` runs it once without `--watch`. The scripts load `.env` with Node's `--env-file`, so
Node 20.6 or newer is required; on an older runtime export the two variables in your shell and run
`node --import tsx src/server.ts`.

| Method | Path | Demonstrates |
|---|---|---|
| `GET` | `/` | Optional auth: reports whether the caller has a session |
| `GET` | `/me` | `orbit.authenticate(req)` on a bare `IncomingMessage`, answered as JSON |
| `GET` | `/admin/users` | `auth.has({ permission })` plus `orbit.client.users.getUserList()` |
| `POST` | `/api/webhooks` | Raw-body collection + `orbit.webhooks.verify()`, 400 on a bad signature |

## Try it

```bash
# 401 without a session token
curl -i http://localhost:3001/me

# with a session JWT copied from the browser (document.cookie is httpOnly; read it in devtools)
curl -s http://localhost:3001/me -H "authorization: Bearer $SESSION_JWT"

# or from the browser cookie the SDK sets
curl -s http://localhost:3001/me --cookie "__session=$SESSION_JWT"
```

For the webhook, register `http://localhost:3001/api/webhooks` on the dashboard's Webhooks page,
copy the endpoint secret into `ORBITID_WEBHOOK_SECRET`, then use **Send test event** there.

## List users

```bash
ORBITID_SECRET_KEY=sk_test_… ORBITID_API_URL=http://localhost:4000 bun run list-users
```

## Typecheck

```bash
bun run typecheck
```

## Notes

- The secret key never reaches the browser and is never logged. `createOrbitId()` throws at boot
  when it is missing, so a misconfigured deploy fails immediately instead of on the first request.
- `GET /me` returns `401` with `{ errors: [{ code, message }] }`, the same shape the OrbitID server
  uses.
- The webhook route reads the body itself (`readBody`) and passes the raw bytes to `verify()`. If you
  use a framework with a JSON body parser, mount the webhook route with `express.raw({ type:
  "application/json" })` before the parser instead.
- The body is capped at 256 KiB; a larger request is rejected instead of being buffered.
