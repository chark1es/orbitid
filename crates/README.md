# OrbitID Rust backend: crate map and conventions

Wave 0 foundation for the TypeScript → Rust port. The HTTP contract is frozen:
routes, JSON shapes, cookies, headers and error bodies match the retired
TypeScript server and `docs/openapi.json` byte-for-byte unless a note below says
otherwise.

## Layering (strictly downward)

```
L4  orbitid-server        binary `orbitid`, CLI, router composition, dashboard/docs
L3  orbitid-fapi-auth     /v1/client sign-in/sign-up/client/handshake/oauth/verify/SSO
    orbitid-fapi-account  /v1/client/me, org client API, waitlist, client API keys
    orbitid-bapi          /v1 Backend API, org backend, webhooks, operator sessions, m2m
    orbitid-oidc          /oauth/*, discovery, device flow, oauth_applications, API keys
L2  orbitid-identity      users, sessions, cookies/auth, trusted devices, orgs, RBAC
L1  orbitid-platform      mail/SMS, webhooks delivery, audit log, captcha, images, stats
    orbitid-credentials   signing keys, JWT, JWKS, templates, argon2, TOTP, WebAuthn
    orbitid-federation    social/custom OAuth & OIDC adapters, SAML SP
L0  orbitid-core          config, db, models, errors, ids, crypto, settings, http, safe_fetch
```

Rules:

- Higher layers depend on lower ones, never the reverse. L1 crates depend only on core.
  L3 crates do not depend on each other.
- Each L3 crate exposes `pub fn router() -> axum::Router<orbitid_core::AppState>`.
  **Routes use absolute paths** (`/v1/client/sign_ins`, `/oauth/token`, …); the server
  merges the routers rather than nesting them, because a surface such as fapi-auth owns
  several mount points.
- Backend API routes are authenticated structurally: `orbitid-server` merges
  `orbitid_bapi::backend_router()` and `orbitid_oidc::backend_router()` and applies
  `orbitid_core::http::require_secret_key` to the merged router. A route added to a
  backend router is guarded automatically; there is no path list to maintain.
- Every authenticated Frontend API handler authenticates **before** its body extractor.
  A pre-body guard (`orbitid-server/src/guard.rs`) resolves the identity for
  `/v1/client/me`, `/v1/client/sessions/:id/*`, organization/API-key routes,
  `/oauth/consent` and `/oauth/device`; an unauthenticated request with a malformed
  body therefore gets 401 (or the handler's 404/403), never 422.
- Feature crates attach their services through `AppState::extensions`
  (`state.extensions.set(Mailer::new(..))`, `state.extensions.get::<Mailer>()`).
  Per-state services are installed with `extensions.get_or_insert(|| …)`, which is
  atomic, so two first requests can never create two mailers/captcha services.
  The operator-session cookie hook is `AppState::set_operator_session_checker`.

## Getting state, pool and settings

```rust
use orbitid_core::{AppState, OrbitError, Result};

async fn handler(state: axum::extract::State<AppState>) -> Result<axum::Json<serde_json::Value>> {
    let settings = state.settings.get();          // Arc<InstanceSettings>, sync and cheap
    let _publishable = &state.publishable_key;
    let _env = &state.env;                        // Arc<Env>
    let _client = &state.http_client;             // ordinary outbound HTTP
    // Never call sqlx::query! macros; use runtime queries and the row models:
    let rows = sqlx::query_as::<_, orbitid_core::models::UserRow>("SELECT * FROM users LIMIT 1")
        .fetch_all(&state.pool)
        .await?;
    Ok(axum::Json(serde_json::json!({ "name": settings.application.name, "rows": rows.len() })))
}
```

`create_context(EnvOverrides)` (in `orbitid_core::state`) connects, migrates, creates
`<data_dir>`, resolves the secret key, loads settings and builds the HTTP client. Feature
seeding (RBAC rows, signing-key readability) belongs to the layer that owns it and runs
once after `create_context`.

Settings writes go through `state.settings.update(serde_json::Value)` (deep merge,
validation, sealing) or `remove_social_providers`. They persist to `instance` and publish
`LISTEN/NOTIFY` on channel `orbitid_settings`; every replica refreshes within 30 s even if
a notification is missed. Settings writes take the `instance` row lock and increment a
database-assigned `revision` in that same `UPDATE`; a replica publishes a snapshot only
when its revision is greater, and learns about commits over `LISTEN/NOTIFY` (payload = the
new revision) or the 30 s refresh, so propagation does not depend on the replicas' clocks
agreeing.

## Errors

Handlers return `orbitid_core::Result<T>` (`Result<T, OrbitError>`). `OrbitError`
implements `IntoResponse`, producing `{ "errors": [...], "trace_id": "..." }`, adding
`Retry-After` for 429s and a `TraceId` extension for the logging middleware.

```rust
use orbitid_core::error::{error_codes, OrbitError, Result};

async fn handler() -> Result<axum::Json<serde_json::Value>> {
    Err(OrbitError::unprocessable(
        error_codes::FORM_PARAM_FORMAT_INVALID,
        "email_address must be an email address",
    )
    .with_meta(serde_json::json!({ "param_name": "email_address" })))
}
```

- `From<sqlx::Error>` maps unique violations (`23505`) to 409 `duplicate_record`, anything
  else to 500 `internal_server_error`.
- Validation with multiple issues can use `.with_items(vec![...])`.
- The 404 fallback body has no `trace_id`: `{ "errors": [{ "code": "resource_not_found",
  "message": "Route not found" }] }`.
- 500s are logged by `http::error_logging` with the response trace id; authentication
  paths (`/v1/client*`, `/v1/operator_sessions`, `/v1/oauth_callback`, `/v1/verify`,
  `/v1/saml`, `/oauth*`) stay silent.

## JSON extractor

```rust
use orbitid_core::http::OrbitJson;
use serde::Deserialize;

#[derive(Deserialize)]
struct SignInBody { identifier: String, password: String }

async fn sign_in(OrbitJson(body): OrbitJson<SignInBody>) -> orbitid_core::Result<String> {
    Ok(body.identifier)
}
```

`OrbitJson` accepts JSON and `application/x-www-form-urlencoded`, treats an empty body as
`{}`, caps at 1 MB (413 `request_body_invalid`), strips `__proto__`/`constructor`/
`prototype`, refuses nesting deeper than 32 and maps missing fields to 422
`form_param_missing` (other problems to `form_param_format_invalid`). Multipart is
deliberately left to upload routes. Pair-typed query pagination: `PaginationQuery`.

## Row models and timestamps

One `#[derive(sqlx::FromRow, Clone, Debug)]` struct per table in
`orbitid_core::models::{identity,sessions,organizations,api,devices,tokens,webhooks}`.

- `bigint` → `i64`; timestamps are unix epoch **milliseconds**.
- `jsonb` → `sqlx::types::Json<T>` (`Jsonb`, `JsonMetadata`, `JsonList` aliases).
- `boolean` → `bool`; `text` → `String`; nullable columns → `Option<T>`.
- Renamed columns use `#[sqlx(rename = "type")]` (e.g. `PermissionRow::permission_type`).

Wire resources live in `orbitid_core::resources` (snake_case, required-null fields
serialize as `null`, TS-optional fields are skipped).

## Integration tests

The harness (`orbitid_core::testing`, feature `test-util`) creates a migrated template
database once per embedded-migration hash (`orbit_template_rs_<hash>`), then
`CREATE DATABASE … TEMPLATE` per test. A changed migration set gets a fresh template; old
ones are left for the operator to drop. The clone is dropped when the value goes out of
scope.

```toml
[dev-dependencies]
orbitid-core = { path = "../orbitid-core", features = ["test-util"] }
```

```rust
use orbitid_core::testing::{test_state, TestClient};
use axum::http::StatusCode;

#[tokio::test]
async fn health_is_public() {
    let ctx = test_state().await;                 // AppState + ephemeral database
    let app = orbitid_server::build_app(ctx.state.clone());
    let client = TestClient::new(app);            // persists Set-Cookie in a jar

    let response = client.get("/health", &[]).await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.value()["database"], "postgres");

    let denied = client.get("/v1/users", &[]).await;
    assert_eq!(denied.status, StatusCode::UNAUTHORIZED);
    assert_eq!(denied.value()["errors"][0]["code"], "secret_key_invalid");
}
```

`TestClient` methods: `get/post/patch/delete(path, body: Option<Value>, headers: &[(&str,
&str)])`, `request(method, path, body, headers)`, `json::<T>(...)`, `cookie_header()`.
`TestResponse` has `status`, `headers`, `body`, `text()`, `value()`, `json::<T>()`,
`error_codes()`. Fixed test config: secret key `sk_test_testsecret`, base URL
`http://localhost:4000`, encryption key
`test-encryption-key-for-orbitid-0123456789`. `ORBITID_TEST_PG_ADMIN_URL` defaults to
`postgres://orbit:orbit@localhost:5432/postgres`.

Other harness pieces: `EphemeralDb` (explicit creation/cleanup), `test_state_with(EnvOverrides)`, and the safe-fetch test transport (`safe_fetch::set_safe_fetch_transport_for_tests`).
Every test state honours `ORBITID_TEST_POOL_MAX` (with `ORBITID_TEST_POOL_ACQUIRE_MS`, default 2000): a handler that takes a second connection while it holds one fails with a pool timeout. CI runs the workspace with it set to 1 (`ORBITID_TEST_POOL_MAX=2` catches two-connection deadlocks), and a test that legitimately needs concurrency calls `orbitid_core::testing::test_pool_exemption(n)` with a comment saying why.

## Transactions, connections and webhook events

- **One transaction, one connection.** A function that has a transaction or
  connection in hand uses the `_on(conn)` variants (`create_user_on`,
  `create_session_on`, `mark_invitation_accepted_on`, `emit_event_on`, the
  `serialize_*_on` payload serializers) and **never acquires a second pool
  connection** while the transaction is open. Completion therefore works on a
  pool of one. Do not call a pool-based helper from inside a transaction.
- **Writers bump and check `version`.** `sign_ins` and `sign_ups` mutations use
  `version = version + 1 … WHERE id = $n AND version = $n` (and refuse terminal
  rows), so exactly one writer wins across replicas and a stale read can never
  reopen a completed attempt. The `version` a request reads is its CAS token: a
  writer never reloads-and-merges behind the caller's back, and completion only
  proceeds when the locked row still has the version that was validated (a
  mismatch is 400 `client_state_invalid`, never a silent overwrite).
- **Transactional outbox.** When a transaction commits a state change, its
  webhook event (`user.created`, `session.created`, `session.ended`/`revoked`,
  `invitation.accepted`, …) is inserted with `emit_event_on` in *that same
  transaction*. A rolled-back change leaves no event; a committed change is
  never lost. Only non-database work (e-mail/SMS delivery, audit, verified-email
  organisation enrolment) stays post-commit and best-effort.
- **`emit_event` is best-effort, not transactional.** The pool-based
  `emit_event` writes the event in its own transaction and cannot be rolled
  back with a change that already committed (nor roll that change back). Use it
  only for a single-statement change whose event loss is tolerable; any
  multi-statement change, or a change whose event must be trustworthy, writes
  `emit_event_on` inside its transaction.
- **Check-then-write takes locks.** Where a decision reads rows and a later
  statement writes based on that decision (last-admin demotion/removal,
  membership capacity, invitation acceptance, sign-up/sign-in completion), the
  rows are locked (`FOR UPDATE`/`FOR SHARE`) in the same transaction, in a
  stable order, before the write.
- **Global lock order (rank 1 = first).** Every multi-row transaction takes its locks in
  this order (`orbitid_identity::locks`): `instance -> clients (id) -> users (then their
  credential/child rows) -> sign_ups -> sign_ins -> verifications -> sessions (id) ->
  organizations (id) -> organization_memberships/invitations/requests (id, after the
  organization) -> roles/permissions (id) -> OIDC grant families then oauth_grants ->
  uploads (file) -> signing-key advisory then signing_keys -> instance-level admin rows`.
  Insert-only rows carry no ordering constraint. Ban/lock/delete take every client of the user
  then the user; **touch never takes the user lock**. See [`docs/LOCK_ORDER.md`](../docs/LOCK_ORDER.md).
  An INSERT/UPDATE of a foreign-key column takes `FOR KEY SHARE` on the parent at the
  parent's rank, so child writers take parents first (`key_share_users_on`,
  `lock_membership_write_on`, `lock_enrollment_on`); `add_membership_on` requires its `MembershipWriteLock` proof.
  Credential issuers (token/refresh/device, consent, API keys, sessions) re-check
  `banned`/`locked` under the lock (`key_share_active_user_on`).
- **Automatic transaction retry (defence in depth).** `40P01`/`40001` map to a retryable 409
  `transaction_conflict`; `orbitid-server::retry` replays the request up to 3 times with
  jittered backoff, only for that marked 409, mutating methods, bodies up to 1 MiB, never
  for OAuth/SAML/enterprise callbacks or uploads. External effects are post-commit; the
  request-private `orbitid_core::http::replay` scope skips the rate-limit debit, memoizes an
  accepted CAPTCHA token and counts a failed attempt once. `orbitid_core::db::with_retry` is
  the transaction-only variant used by the workers.

### `_on` helper families

Every multi-write domain operation has an `_on(&mut PgConnection, …)` variant that joins the
caller's transaction; the pool-named function is a thin wrapper that opens a transaction,
calls `_on` and commits. HTTP crates compose these inside one transaction. The families
(all in `orbitid-identity` unless noted):

- users: `create_user_on`, `emit_user_created_on`, `delete_user_on`, `upgrade_anonymous_user_on`,
  `record_failed_attempt_on`, `reset_failed_attempts_on`, `delete_email_address_on`,
  `delete_phone_number_on`, `touch_user_on`, `moderate_user_on` (`ModerationAction`).
- identifiers: `link_external_account_on`, `delete_external_account_on`,
  `find_external_account_on`.
- verification: `issue_verification_on`, `check_code_on`, `consume_link_on`,
  `get_verification_by_id_on`.
- sessions/credentials: `end_sessions_for_user_on`, `end_other_sessions_on`,
  `revoke_grants_for_session_on`, `revoke_grants_for_sessions_on`, `revoke_grants_for_user_on`,
  `revoke_organization_authority_grants_on`, `revoke_api_keys_for_subject_on`
  (`orbitid-credentials`: `add_passkey_on`, `delete_passkey_on`, `disable_totp_on`).
- roles: `set_user_roles_on`; `create_role_on`, `update_role_on`, `delete_role_on`,
  `set_role_permissions_on`, `add_role_permission_on`, `remove_role_permission_on`,
  `create_permission_on`, `update_permission_on`, `delete_permission_on`,
  `assert_role_deletable_on`.
- restrictions: `create_invitation_on`, `revoke_invitation_on`,
  `create_allowlist_identifier_on`, `delete_allowlist_identifier_on`,
  `create_blocklist_identifier_on`, `delete_blocklist_identifier_on`,
  `create_waitlist_entry_on`, `set_waitlist_entry_status_on`, `delete_waitlist_entry_on`.
- organizations: `add_membership_on`, `assert_organization_capacity_on`,
  `accept_invitation_on`, `create_organization_invitation_on`,
  `revoke_organization_invitation_on`, `on_user_email_verified_on`,
  `enroll_candidates_on`, `on_user_deleted_on`, `delete_organization_on`,
  `leave_organization_on`, `accept_membership_request_on`,
  `create_membership_request_on`, `reject_membership_request_on`, plus the
  `*_on` serializers needed for transactional webhook payloads.

## L2 identity crate (`orbitid-identity`)

The shared domain layer for all four HTTP crates: users and identifiers,
sessions, client cookies/auth, trusted devices, operator sessions, organizations,
RBAC, domains, restrictions, verifications and every wire serializer. Nothing
here writes an HTTP response: functions take `&AppState` plus plain values
(headers, ids, options) and return rows or JSON resources.

```rust
// Once, after create_context / in test setup:
let handles = orbitid_identity::install(&state).await?;   // or install_without_workers
```

`install` attaches the platform `Mailer` and captcha service, runs `seed_rbac`,
checks the signing keys are readable with this process's encryption key,
registers the operator-session hook for core's `require_secret_key`, and starts
the guest-cleanup worker. Keep `InstallHandles` for the process lifetime (or
call `shutdown()`); `install_without_workers` is for tests and short-lived tools.

### Module map (all public)

| Module | Contents |
| --- | --- |
| `serializers` | `serialize_user(s)`, `serialize_session(s)`, `serialize_organization(s)`, `serialize_membership(s)`, `public_user_data`, email/phone/external/passkey/trusted-device serializers. Batch forms avoid N+1 queries. |
| `users` | `create_user`, `require_user`, `find_email`, `normalize_email/phone`, `get_user_by_identifier`, `delete_email_address`, `record_failed_attempt`, `upgrade_anonymous_user`, profile/identifier guards. |
| `sessions` | `create_session`, `end_session`, `touch_session`, `slide_session_activity`, `evaluate_session_status`, `session_expire_at/expires_at`, MFA enrollment completion, sign-in email. |
| `tokens` | `sign_session_token(state, session_id, opts)` (loads user/org/roles then delegates to credentials), `verify_session_token`. |
| `client_auth` | `read_client_token`, `get_or_create_client`, `renew_client_cookie_if_due`, `regenerate_client_token`, `serialize_client(_with)`, `active_client_session`, `require_active_user`, `client_azp`. Cookie helpers return `Set-Cookie` strings. |
| `trusted_devices` | label parsing, issue/redeem (rotating), list/revoke, cookie helpers. |
| `operator_session` | key fingerprint, issue/find/revoke/sweep, origin rule, the `OperatorSessionChecker` hook. |
| `orgs`, `rbac`, `org_domains`, `org_serializers`, `org_shared` | invitations/enrollment, seed RBAC, role/permission checks, domain normalization/suggestions, wire serializers, slug/list/merge helpers. |
| `restrictions`, `verifications` | sign-up gating + tickets; one-time codes/magic links. |
| `external_identity`, `enterprise_access` | external-account linking/profile policy; enterprise connection gates + attribute sync. `handleExternalIdentity` itself (the sign-in/up state machine) belongs to `orbitid-fapi-auth`. |
| `caller`, `machine_auth` | caller resolution from cookie / session JWT / client token for organization and machine routes. |
| `admin` | Backend API pure helpers (`query_values`, `merge_metadata`, `refuse_user_credential_mutation`, `ticket_url`, `revoke_sessions`). |
| `grants`, `api_keys` | Canonical credential revocation shared by every surface: `revoke_organization_authority_grants`, `revoke_api_keys_for_subject`. L3 crates call these instead of keeping local copies. |

### Testing (`test-util`)

```toml
[dev-dependencies]
orbitid-identity = { path = "../orbitid-identity", features = ["test-util"] }
```

```rust
use orbitid_identity::testing::{test_app_state, sign_up_user, create_test_organization};

let app = test_app_state().await;               // fully installed, ephemeral DB
let signed_up = sign_up_user(app.state(), "a@b.co", "Sup3r-secret!").await?;
// signed_up.user.user / signed_up.auth.cookie / .session / .jwt
let org = create_test_organization(app.state(), "Acme", None, &signed_up.user.user.id).await?;
```

Other fixtures: `create_test_user`, `create_test_unverified_user`,
`create_test_guest`, `create_test_client_session`, `add_test_member`,
`enable_totp`, `enable_trusted_devices`, `test_app_state_with(EnvOverrides)`.
`app.context.state` is the `AppState`, `app.context.db` the disposable database.

Upper crates supply `ClientJSON.sign_in`/`sign_up` (via `serialize_client_with`) and the
cookie plumbing for session-token rotation (`CreatedSession::client_token`).

## Naming conventions (TypeScript → Rust)

| TypeScript | Rust |
| --- | --- |
| `src/env.ts` | `core::config` (`Env`, `load_env`, `EnvOverrides`) |
| `src/bootstrap.ts` | `core::state::create_context` |
| `src/context.ts` | `core::state::AppState` |
| `src/db/schema-parts/*.ts` | `core::models::*` (row structs) |
| `src/settings.ts` | `core::settings::store` |
| `shared/config.ts` | `core::settings::types` |
| `lib/settings-policy.ts` | `core::settings::policy` |
| `lib/http.ts` | `core::http::{json,client_ip}` |
| `lib/security.ts` | `core::http::security` |
| `lib/rate-limit.ts` | `core::http::rate_limit` |
| `lib/safe-fetch.ts` | `core::safe_fetch` |
| `lib/secrets.ts` / `lib/crypto.ts` | `core::secrets` / `core::crypto` |
| `lib/db.ts` | `core::db::helpers` |
| `shared/errors.ts` | `core::error` |
| `shared/resources.ts` | `core::resources` |
| `shared/keys.ts` | `core::keys`, `core::ids` |
| `src/app.ts` | `orbitid-server::app::build_app` |
| `src/cli.ts` | `orbitid-server::cli` |

Camel-case TS fields become snake_case Rust fields; serde renames are only needed where
the wire format is camelCase (settings) or a reserved word (`type`). Every table is
`FooRow`; every wire resource is `FooJson`.

## Commands

```bash
export PATH=$HOME/.cargo/bin:$PATH

cargo build --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
cargo test --workspace

# One crate, with its own target directory:
CARGO_TARGET_DIR=target-orbitid-core cargo test -p orbitid-core
CARGO_TARGET_DIR=target-orbitid-core cargo test -p orbitid-core --features test-util
CARGO_TARGET_DIR=target-orbitid-fapi-auth cargo test -p orbitid-fapi-auth
```

Tests need the local Postgres (see `ORBITID_TEST_PG_ADMIN_URL`). `Cargo.lock` is tracked;
`/target` and `/target-*` are ignored.

## Porting notes / deliberate deviations

- **Postgres only.** SQLite, PGlite and `:memory:` are refused at startup. The
  “keys.json” branch of `bootstrap.ts` remains implemented but is unreachable in
  practice: Postgres already requires `ORBITID_ENCRYPTION_KEY`, so the secret key is
  derived from it exactly like the TS server.
- **Rate limiting is distributed.** The TS implementation was per-process; this one uses the `rate_limit_windows` table (migration 0002) plus a per-process negative cache. Limits hold across replicas, and both the window and `Retry-After` use the database clock, not the replica's.
- **Migrations.** `0001_baseline.sql` is a byte-for-byte replay of drizzle 0000–0009. An existing drizzle deployment is detected through `drizzle.__drizzle_migrations` and baselined; a database behind 0009 is refused with an actionable message. Concurrent boots are serialised by OrbitID's own startup session advisory lock (`orbitid_startup_migrations`, held on one connection across index repair, baselining and migrations; sqlx's migration lock is disabled for that run). After migrations, required indexes of `-- no-transaction` migrations are recreated if missing, because a recorded migration does not prove its index exists.
- **Middleware shape.** Hono middleware became axum layers in `orbitid-server`: request logging → error logging → security headers → OIDC CORS → upload cap → CSRF → Frontend CORS → pre-body auth → request timeout → routes. The Backend API auth layer sits around the merged backend routers and also guards unknown `/v1/*` paths in the fallback (the TS backend sub-app guards its whole mount point). `require_secret_key` compares the bearer token and counts failures in Postgres; the operator-cookie path is a hook (`OperatorSessionChecker`).
- **Validation.** Typed `serde` structs replace zod. Error codes, status and
  `meta.param_name` match (`form_param_missing` / `form_param_format_invalid`), but the
  human-readable message text comes from serde and is not guaranteed to be character
  identical for non-missing fields.
- **Defaults.** `Env` pool tuning adds `ORBITID_DB_MAX_CONNECTIONS` (20) and
  `ORBITID_DB_ACQUIRE_TIMEOUT_MS` (30 000); `ORBITID_REQUEST_TIMEOUT_MS` (30 000,
  0 disables) caps handler time and `ORBITID_DRAIN_TIMEOUT_MS` (10 000) is the
  graceful-shutdown drain deadline. `GET /health` is dependency-free; `GET /ready`
  runs `SELECT 1` and returns 503 until the database answers, for load balancers.
- **Not ported:** `remoteJwks`/jose helpers are provided by credentials, the SDK-only
  `AuthObject` is intentionally client-side, and multipart parsing belongs to the
  upload routes. The interactive `/docs` viewer is the TypeScript one, embedded from
  `crates/orbitid-server/assets/docs/` and served under the same strict CSP.
- **CLI uploads.** `orbitid import-uploads --from <dir>` imports a legacy
  TypeScript `<dataDir>/uploads` tree into the `uploads` table under the same
  public names and buckets, validating each file and skipping existing rows.
- **CLI transfer.** `orbitid export` / `import` / `copy` use the TypeScript JSON Lines
  format (header + portable rows, encryption-key canary). Only Postgres is supported:
  SQLite and PGlite sources are refused and the help says so. `copy` runs a Postgres →
  Postgres transfer in one step.

## Composition, workers and startup

`orbitid_server::build_app` mounts, in the TypeScript app's order:

1. `GET /health`, `GET /ready`
2. `orbitid_credentials::routes::jwks_router()` (`/.well-known/jwks.json`, `/v1/jwks`)
3. `orbitid_oidc::router()` (`/oauth/*`, discovery, `/oauth/jwks`, device page,
   `/v1/client/me/api_keys`, `/v1/oauth_applications` with its internal secret-key guard)
4. `orbitid_fapi_auth::router()`, `orbitid_fapi_account::router()`
5. `orbitid_bapi::router()` (operator-session exchange)
6. the merged Backend API routers under `require_secret_key`
7. `/v1/openapi.json`, `/docs` + `/docs/assets/*`
8. the dashboard SPA fallback (non-API GETs when a build exists)

`orbitid_server::cli::start` runs `orbitid_identity::install` (mailer/captcha, RBAC seed,
signing-key readability, operator-session hook), starts `WebhookWorker` (2 s delivery
loop, rows claimed with `SKIP LOCKED`, safe on every replica) and the anonymous-user
cleanup worker (started by `install`), then serves until SIGINT/SIGTERM. Shutdown stops
accepting connections, drains in-flight requests for `ORBITID_DRAIN_TIMEOUT_MS`, and
stops the workers. The settings store already runs its own `LISTEN/NOTIFY` refresher
(30 s fallback), so a settings change made on one replica is observed by the others.

### Retention

`install` also starts the retention worker (`orbitid_identity::retention`). Every
independent table is drained by its **own short transaction** in the global lock order
(clients → sign_ups → sign_ins → sessions for the session sweep; one table elsewhere), each
batch under `pg_try_advisory_xact_lock('orbitid_retention')`, selecting candidates with
`ORDER BY … FOR UPDATE SKIP LOCKED` where harmless and retried within the same tick on
`40P01`/`40001` (`with_retry`); a failing operation is logged and the rest of the tick runs.
Each batch returns the `(time, key)` of its last candidate; the next starts after it, and the
position is also kept in `worker_cursors` so a zero/expired budget still advances across ticks
(wrapping at the end). Deletes run in a savepoint with per-row isolation, so a row that keeps
failing cannot stall the rows behind it. `ORBITID_RETENTION_BATCH_SIZE` (500),
`ORBITID_RETENTION_INTERVAL_MS` (one hour) and `ORBITID_RETENTION_BUDGET_MS` (30 s) tune it.

The anonymous-user cleanup worker (every five minutes, 100 guests) takes the
**transaction-scoped** advisory lock per candidate and deletes **each candidate in its own
transaction** (clients → user → organization lifecycle → uploads); its keyset position is
durable (`worker_cursors`) too.

The domain-enrollment worker (`orgs::enrollment_worker`, `ORBITID_ENROLLMENT_INTERVAL_MS`)
resumes every domain with `enrollment_pending_since` set (written in the transaction that
verifies/switches the domain): one chunk per transaction under a per-domain advisory
try-lock, cursor persisted per chunk, marker cleared at the end. Handlers do one small chunk
inline and wake it (`kick_domain_enrollment`).

Rows are kept for a 24-hour grace period beyond the point they stop being useful:

| Table | Removed when |
| --- | --- |
| `verifications` | `expires_at` or `consumed_at` is older than the grace period |
| `oauth_grants` | `expires_at` is older than the grace period **and** no live row remains in the same rotation family (reuse detection needs revoked refresh tokens until the family expires) |
| `device_codes` | `expires_at` older than the grace period |
| `oauth_states` | `expires_at` older than the grace period (includes SAML/enterprise replay rows) |
| `sign_ins`, `sign_ups` | `abandon_at` older than the grace period and not referenced by an active/pending session |
| `sessions` | status is `ended`, `revoked`, `expired` or `removed` **and** `updated_at` is older than 90 days; `active`/`pending` rows are never touched. The sweep locks and clears the text pointers in lock-rank order — `clients.last_active_session_id` (rank 2), `sign_ups.created_session_id` (rank 4), `sign_ins.created_session_id` (rank 5) — then deletes the sessions (rank 7); `oauth_grants` has no foreign key and is handled by its own sweep. Before the deletion sweep, `expire_stale_sessions` marks `active`/`pending` rows past `expire_at` or the inactivity timeout as `expired`, revokes their grants and writes `session.ended` exactly like the lazy read path, so they become eligible |
| `clients` | `updated_at` older than the `__client` cookie's own lifetime (400 days) plus the 24 h grace, and no session, no non-terminal sign-in and no non-terminal sign-up reference it. `find_client` refreshes `updated_at` (at most hourly) for any request that presents the cookie, so an active browser never ages into the sweep |
| `webhook_deliveries` | status is terminal (`success` or `failed`; `failed` is only set after the last retry) and `created_at` is older than `ORBITID_WEBHOOK_RETENTION_DAYS` (default 30; `0` keeps forever) |
| `webhook_events` | `created_at` is older than `ORBITID_WEBHOOK_RETENTION_DAYS` **and** every delivery that references the event is terminal (an event with no deliveries is eligible too) |
| `audit_logs` | only when `ORBITID_AUDIT_RETENTION_DAYS` is greater than 0: `created_at` older than that many days. The default `0` keeps audit trails forever |
| `uploads` | `created_at` older than the 24 h grace and no `users.image_file` / `organizations.image_file` (generated from the pointer, indexed by `0009_upload_owner_index.sql`) equals the file name (covers abandoned uploads and rows orphaned before deletion removed them) |

Retention queries use the indexes from `0008_retention_indexes.sql` and
`0009_upload_owner_index.sql` (`image_file` on users/organizations, partial
session-expiry indexes). Orphan detection is `image_file = uploads.file`, an
index lookup, not the old `right(image_url, …)` expression.

### Uploads

`orbitid_identity::uploads` is the one canonical store: `store_upload_on`,
`delete_upload_on`, `delete_uploads_for_owner_on` and the `delete_*_for_*_on`
helpers. Every pointer change deletes the old row in the same transaction, and
every entity deletion removes rows by owner id *and* the row its own stored
pointer references (so an owner-less legacy avatar still disappears). The
anonymous cleanup reuses `delete_user_on`, so the organization lifecycle runs
before the user row. File names are globally unique; a cross-bucket collision
is a 409, never an overwrite. `import-uploads` resolves an owner from the
pointer and refuses a symlinked `uploads/orgs`. Never unlink a legacy
`<data_dir>/uploads` path; run `orbitid import-uploads --from <data dir>` once.

The client grace is tied to `COOKIE_MAX_AGE_SECONDS`, not 24 h. `sweep_once(state, Some(at), Some(limit))` takes an injected clock.

Startup banner (the retired TypeScript server's fields plus the version, then `email_startup_warnings`):

```
  OrbitID is running at https://auth.example.com
  Dashboard       : https://auth.example.com
  Publishable key : pk_live_...
  Secret key      : hidden. Print it with: orbitid keys
  JWKS            : https://auth.example.com/.well-known/jwks.json
  Database        : postgres://orbit@db:5432/orbitid
  Version         : 1.4.2
  Email           : Resend
```
