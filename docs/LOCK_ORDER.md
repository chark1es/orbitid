# Global lock order, transaction audit and retry

The reference for `orbitid_identity::locks`, which enforces the order: this
explains it, audits every transaction and covers request-level retry.

## Rank order (rank 1 is acquired first)

| Rank | Rows | Rule |
| --- | --- | --- |
| 1 | `instance` | the settings row; never combined with domain rows |
| 2 | `clients` | ascending `id` |
| 3 | `users`, then the rows a user owns: `email_addresses`, `phone_numbers`, `external_accounts`, `trusted_devices`, `passkeys`, `api_keys` | user row first, then its child rows in ascending `id` |
| 4 | `sign_ups` | |
| 5 | `sign_ins` | |
| 6 | `verifications` | |
| 7 | `sessions` | ascending `id` |
| 8 | `organizations` | ascending `id` |
| 9 | `organization_memberships`, `organization_invitations`, `organization_membership_requests` | ascending `id`; the organization row (rank 8) is always locked before any of these child rows |
| 10 | `roles`, `role_permissions`, `permissions`, `user_roles` | ascending `id`; within the rank parent before child: role row, then the referenced `permissions` rows (`FOR KEY SHARE`, ascending), then `role_permissions` rows |
| 10a | `oauth_applications` | [APP_ACCESS.md](APP_ACCESS.md#locking) |
| 11 | OIDC grant families (advisory), then `oauth_grants` | `pg_advisory_xact_lock`, ascending family name; grant rows only after their family lock |
| 12 | `uploads` | ascending `file` |
| 13 | signing-key advisory lock, then `signing_keys` | `keys::ADVISORY_LOCK`; `signing_keys` rows only inside that transaction |
| 14 | instance-level admin rows: `invitations`, `waitlist_entries`, `enterprise_connections`, `jwt_templates` | each transaction locks one of these rows (or inserts one) and no domain rows |

Insert-only outbox rows (`webhook_events`, `audit_logs`, `email_addresses`,
`phone_numbers`, `rate_limit_windows`, `oauth_states`, `device_codes`) carry no
ordering constraint after their owner row. A row
that is also *locked* (`email_addresses`, `phone_numbers`,
`external_accounts`, `trusted_devices`, `passkeys`, `api_keys`) follows the
owner row at rank 3 as shown above. `oauth_grants` rows are written after their
family's advisory lock (rank 11). The worker advisory locks
(`orbitid_retention`, `orbitid_anonymous_cleanup`, and the per-domain
`orbitid_enrollment:<domain id>` *try*-lock of the enrollment worker, which
never waits) and `orbitid_owner_setup` (owner setup, imports) are taken at the
start of their own transaction, holding nothing else, so no cycle is possible. The startup lock
`orbitid_startup_migrations` is a *session* advisory lock held on one dedicated
connection across invalid-index cleanup, drizzle baseline and migrations; it is
acquired by polling `pg_try_advisory_lock` (a statement blocked in
`pg_advisory_lock` would hold a snapshot that the holder's
`CREATE INDEX CONCURRENTLY` waits for) and runs before any request or worker
transaction exists. Worker scan positions (`worker_cursors`: guest cleanup,
`enrollment_domains`) are plain upserts outside any transaction that holds other
locks, so they take no part in the order.

A transaction that does not know the user or client up front resolves it with a
plain read and then takes the locks in rank order. Ban/lock/delete lock every
client the user has a session for (ascending `id`) and then the user. Touch
does not take the user lock at all: its session write is a short transaction and
the throttled `last_active_at` update runs afterwards as a single autocommit
statement, which holds one row and waits for nothing.

`locks::lock_client_on`, `lock_clients_on`, `lock_user_on`,
`lock_client_then_user_on`, `lock_clients_for_user_on` and
`lock_user_clients_then_user_on` (and `lock_sign_up_on` / `lock_sign_in_on` for ranks 4/5) are the only way to take these locks.
`save_sign_up_on` and `transition_sign_in_on` take the client lock themselves, so
a sign-up/sign-in writer cannot forget it. Multi-row statements in one table
lock `ORDER BY <primary key> FOR UPDATE` first and then update by ids.

## Explicit rollback

A dropped sqlx transaction only *queues* its rollback; sqlx-core 0.8.6 flushes
it when the connection is returned to the pool (`PoolConnection::drop` spawns
`return_to_pool`, which pings the connection), so the locks are released
shortly after the drop but not at a point the caller can wait on. Every non-commit exit
of a transaction whose locks later work needs (a retry, the next worker batch,
another replica, the next request of the same handler) therefore ends in an
awaited `tx.rollback()` as defence in depth. `orbitid_core::db::finish_transaction` (commit on `Ok`,
awaited rollback on `Err`) is the shared form; the retention sweeps, the
enrollment worker, the anonymous cleanup, the settings writer, the signing-key
writers and the magic-link handler use it or the same pattern.

## Foreign-key locks count at the parent's rank

An `INSERT` or `UPDATE` of a foreign-key column takes a `FOR KEY SHARE` row
lock on **every referenced parent row**, and that is a lock at the parent's
rank. A transaction that writes a child row referencing a ranked parent
(`clients`, `users`, `sign_ups`, `sign_ins`, `sessions`, `organizations`, …)
while it holds, or will later take, another ranked lock must therefore take
those parents explicitly first, in rank order, and revalidate after locking (a
missing parent row is the same not-found error the path returns today). The
`orbitid_identity::locks` helpers are the only way:

| Helper | Parent rank | Used by |
| --- | --- | --- |
| `key_share_user_on` | 3 | `oauth_grants`, `oauth_consents`, `device_codes`, `passkeys`, membership/request writers: the user must exist (not found otherwise) |
| `key_share_active_user_on` | 3 | credential issuers: returns `banned`/`locked` **as read under the lock** (`None` = deleted); token exchange, refresh, device poll/approval, consent, API-key creation re-check it, `create_session_on` re-checks the row it reads after `lock_user_on`; `sign_session_token` re-checks with a `FOR KEY SHARE` read after signing |
| `lock_sign_up_on(id)`, `lock_sign_in_on(id)` | 4 / 5 | `FOR UPDATE` on the attempt row **before** the first `verifications` write of the transaction (code check, issue, link consume, passkey challenge); the later version-CAS write still decides staleness |
| `lock_users_on(ids)` | 3 | `FOR UPDATE` ascending; the claim purge |
| `key_share_users_on(ids)` | 3 | bulk writers: ascending ids, **skips users that no longer exist** and returns the ids it locked; `key_share_all_users_on` is the strict form |
| `lock_organization_on`, `lock_organizations_on(ids sorted)` | 8 | capacity checks, invitation/request/domain writes |
| `lock_membership_write_on(user_ids, organization_ids)` | 3 → 8 | strict; returns the `MembershipWriteLock` proof required by `add_membership_on` and `assert_organization_capacity_on` (the proof must cover both the organization **and** the user of the write) |
| `lock_enrollment_on(candidates, organization_ids)` | 3 → 8 | bulk enrollment: vanished users skipped; the proof covers only the users actually locked |

`ON DELETE CASCADE`/`SET NULL` is the mirror image: the parent delete takes
locks on the child rows. Organization deletion takes the organization first;
user deletion locks every client, then the user, then the organizations,
memberships and requests it cascades into; session/client deletions are
single-table and follow the same ranks. The audit below lists implicit FK
locks as part of each transaction's sequence.

## Organization-authority changes versus token issuance

Removing, demoting or leaving a member and deleting an organization revoke the
affected users' organization-authority grants. That revocation must not miss a
token row that an in-flight code exchange, refresh rotation or device poll has
inserted but not committed (the revoker's `UPDATE` would wait on the code row
and then see only its own snapshot). Both sides therefore meet on the **user
row**: every issuer takes `key_share_active_user_on` (`FOR KEY SHARE`) and every
revoking path takes `lock_user_on` (`FOR UPDATE`, which conflicts) **before**
the organization lock: `leave_organization_on`, BAPI/FAPI membership update and
delete, and `delete_organization_on` (the members are read plainly, locked
ascending, the organization is locked, and the members are re-read; a member who
joined in between is a retryable `transaction_conflict`). User removal already
holds the user. The revoker's `UPDATE` runs after the lock, so it sees every committed token.
The set-based revocation (`revoke_organization_authority_grants_for_users_on`)
takes **no** per-family advisory locks: its precondition is that the caller holds
every user `FOR UPDATE`, which every issuer's user key-share conflicts with (a
lock per family would exhaust the shared lock table). Every caller holds the user lock (membership update/remove,
leave, user deletion, organization deletion, promotion after user deletion), and
the pool wrapper `revoke_organization_authority_grants` takes it itself. 
The predicate is the application's current authority scopes **or** the grant's own stored ones (`organizations`, any `groups`). The
auto-consent path (`discovery.rs`, autocommit `issue_authorization_code`) relies on the foreign key's implicit `FOR KEY SHARE` on `users`, not an explicit one.

The organization claims are planned before the issuing transaction (a pool-of-one
process cannot read through a second connection while holding the first). Each
issuer therefore reads an authority snapshot (`token_set::authority_snapshot`:
the memberships with organization id, slug, name and role, the session's active
organization and the permission keys of its role) **before** planning, builds
**every** organization-derived claim (`org_*`, `organizations`, organization
`groups`, ID-token equivalents) from that same value, and compares it again
**under** the user key-share (`authority_unchanged_on`). The claims never come from a second read (an ABA such as promote then
demote): the token carries exactly the snapshot.
A difference refuses the issuance with `invalid_grant` (device poll:
`authorization_pending`, the next poll re-plans); a concurrent role-permission
edit also fails the compare and the client retries. Instance-role `groups` stay outside it (as in TS). Tests: `tests/authority_race.rs`.

User deletion's last-admin promotion is an authority change too:
`delete_user_on` locks the user and the pre-read candidates together (rank 3,
ascending) before any organization, re-checks them (retryable conflict) and
revokes the promoted members' grants after rank 10. Organization deletion
revokes members' grants set-based.

### FK class sweep

Every foreign key in `crates/orbitid-core/migrations/*.sql` whose parent is a
ranked table, every `INSERT`/`UPDATE` of that column in `crates/*/src`
(`orbitid-identity`, `-oidc`, `-credentials`, `-federation`, `-platform`,
`-fapi-*`, `-bapi`), and the locks taken **earlier in the same transaction**. A
child-row lock or any higher-rank lock taken before the parent key-share is a
violation.

| Child → parent (rank) | Writing sites | Locks before the write | Verdict |
| --- | --- | --- | --- |
| `sessions.client_id` → `clients` (2), `sessions.user_id` → `users` (3) | `sessions::create_session_on` | its first statement locks client then user (`lock_client_then_user_on`) | OK |
| `sign_ins.client_id`, `sign_ups.client_id` → `clients` (2) | `signup/routes.rs`, `signin/creation.rs`, `external.rs` (`new_sign_in/up`: one autocommit insert); `external_signin::new_sign_in_on` | autocommit: none; `_on`: client locked first | OK |
| `email_addresses.user_id`, `phone_numbers.user_id` → `users` (3) | `users::create_user_on`, BAPI `users/create.rs` (the user row is inserted earlier in the same transaction); FAPI `me/identifiers/{email,phone}.rs` | none: the insert is the transaction's first statement (a new child row nobody else can lock), then the `users` update | OK |
| `external_accounts.user_id` → `users` (3) | `external_identity::link_external_account_on` (+ refresh `UPDATE`); `signup::completion` | `link…_on` locks the user `FOR UPDATE` first; completion inserts after creating the user in the same transaction | OK. **Fixed:** `external_signin::complete_sign_up_for_existing_user` updated `sign_ups` (rank 4) before the link took the user (rank 3); it now takes client then user first |
| `passkeys.user_id` → `users` (3) | `credentials::passkeys::add_passkey_on` via `finish_passkey_registration_on`; pool `finish_passkey_registration` | `finish…_on` claims the challenge (`verifications`, rank 6) first | **Fixed:** the FAPI handler takes `key_share_user_on` before calling it. Pool variant: one autocommit statement per step, OK |
| `trusted_devices.user_id` → `users` (3) | `trusted_devices::issue_trusted_device` (autocommit insert); `issue_trusted_device_on` (second-factor attempt) | `_on`: client then user already held | OK |
| `oauth_grants.user_id` → `users` (3) | `token_set::insert_grant` ← code exchange (`tokens.rs`), refresh rotation (`refresh.rs`), device token poll (`device.rs`), consent code issuance (`routes/consent.rs`) | exchange/refresh: user key-share first, then code row / family advisory (rank 11) | OK. **Fixed:** the device poll updated `device_codes` before the grant insert referenced the user; it now key-shares the user first. |
| `oauth_consents.user_id` → `users` (3) | `consent::record_consent_on` | **was:** `SELECT … FOR UPDATE` on the consent row, then the insert | **Fixed:** `record_consent_on` takes `key_share_user_on` first. Test: `lock_order_oidc.rs` |
| `device_codes.user_id` → `users` (3) | `device::decide_device_code` (approval writes `user_id`) | **was:** one `UPDATE device_codes` (device row lock, then the FK key-share inside the statement) | **Fixed:** transaction with `key_share_user_on` before the update. Test: `lock_order_oidc.rs` |
| `user_roles.user_id` → `users` (3), `user_roles.role_key` → `roles` (10) | `user_roles::set_user_roles_on` | user `FOR UPDATE` via `lock_user_on` (was a no-op `UPDATE users`), then `user_roles` | OK (code and comment now agree) |
| `organization_memberships.user_id` → `users` (3), `.organization_id` → `organizations` (8) | `orgs::add_membership_on` (requests, invitations, enrollment, BAPI/FAPI create) | the `MembershipWriteLock` proof: users ascending, then organizations; the insert checks `covers(organization, user)` | OK |
| `organization_membership_requests.user_id` (3), `.organization_id` (8) | `create_membership_request_on`, `accept_membership_request_on` | user key-share, organization, then the request row | OK |
| `organization_invitations.organization_id` → `organizations` (8) | `create_organization_invitation_on` | organization locked first | OK |
| `organization_domains.organization_id` → `organizations` (8) | FAPI/BAPI domain create | organization `FOR UPDATE`, then duplicate check + insert | OK |
| `role_permissions.role_id` → `roles`, `.permission_id` → `permissions` (10) | `authorization::replace_role_permissions`, `rbac::roles` (`add_role_permission_on`), `seed_rbac` | role locked first, then every referenced permission `FOR KEY SHARE` (ascending) **before** any `role_permissions` row is deleted or inserted; `delete_permission_on` locks the permission, then its `role_permissions` rows ascending. Replacement versus permission deletion used to cycle (replacer holds the child row and waits for the parent key-share, deleter holds the parent and waits for the child via the cascade). Test: `orbitid-identity/tests/lock_order_rbac.rs`. `seed_rbac` is a startup insert with `ON CONFLICT DO NOTHING` and is not concurrent with deletions | OK (fixed) |
| `actor_tokens.user_id`, `sign_in_tokens.user_id` → `users` (3) | none in `crates/*/src` | n/a | no writer |
| `*.application_id` → `oauth_applications` (10a) | [APP_ACCESS.md](APP_ACCESS.md#locking) | | OK |
| `webhook_deliveries.*`, `m2m_tokens.machine_id` | | unranked | OK |

Child `UPDATE`s were checked too: no ranked FK column is updated except
`external_accounts.user_id` (same user, user already locked) and
`device_codes.user_id` (fixed above).

## Documented exceptions

* **`FOR SHARE` on another user's verified identifier row.** Verifying an email
  or phone (`fapi-account me/identifiers/email.rs`, `phone.rs`: `SELECT … WHERE
  email|phone = $1 AND verified = true FOR SHARE`) share-locks the row of a
  *different* user that already owns the identifier, after the caller's own
  user lock (rank 3) and verification row (rank 6). It is a duplicate check: the
  share lock only waits for a concurrent writer of that one row (that user's
  delete/unverify), which holds its own user lock and never waits for the
  caller's rows, so no cycle can close through it. Claim purges that must
  write another user's identifiers lock those users `FOR UPDATE` first
  (`lock_unverified_claim_owners_on`).
* **Domain `DELETE` without an organization lock.** `organization_domains`
  deletes (`fapi-account orgs/domains.rs` `delete`, `bapi org_backend/domains.rs`)
  take no organization lock: the statement locks only the domain row, no
  foreign key is written, and the domain has no child rows. Organization
  deletion cascades into the domain after it holds the organization, and a
  domain writer that also needs the organization (mode change, verification)
  takes it first; a bare domain delete never waits for anything else.

## Transaction audit

Every transaction family in `crates/*/src`, with the tables it writes/locks in
order. "OK" means the sequence follows the rank order (or is a single/insert-only
statement that cannot participate in a cycle). Rows marked "fixed" were audited
in this pass.

| Function | Lock/write sequence | Status |
| --- | --- | --- |
| `users::create_user` / `delete_user` | client(s)→user→sessions→orgs→memberships/requests→user_roles→grants→uploads→`users` delete; parent-delete cascade therefore never takes a lower rank late | OK (fixed) |
| `users::set_primary_email` / `set_primary_phone` | user→address row→users | OK |
| `users::delete_email_address_on` / `delete_phone_number_on` | user→address row→users | OK |
| `users::record_failed_attempt_on` | user→trusted_devices | OK |
| `users::moderate_user_on` (ban) | clients→user→sessions→grants→trusted_devices→api_keys | OK |
| `users::lock_unverified_claim_owners_on` + `users::purge_unverified_claims_on` (add-email verification, `users::create_user_on`, `users::purge_unverified_claims`) | plain read of the other claimants → every involved user `FOR UPDATE` ascending (rank 3), **before** the verification row (rank 6) → revalidate rows under the locks → delete/clear primary of locked owners only | OK (fixed: was unordered, unlocked cross-user writes after the rank-6 row) |
| `users::upgrade_anonymous_user_on` | one users statement | OK |
| `anonymous::delete_candidate_once` | worker advisory→clients→user→(delete_user_on: orgs→memberships→sessions→grants→uploads), one transaction per candidate | OK (fixed) |
| `console::{create,grant}_owner` | advisory→claim→user→user_roles | OK |
| `sessions::create_session_on` | client→user→sessions→clients (held)→events | OK |
| `sessions::complete_mfa_enrollment_on` | client→user→sessions→grant families | OK |
| `sessions::end_sessions_for_user_on` | user→sessions (ordered)→grant families | OK |
| `sessions::end_session` / `sessions_fapi::end_session_on` | client→session→grants→clients (held) | OK |
| `sessions::evaluate_session_status` | client→session→grants | OK |
| `sessions::touch_session` / `touch_session_on` | session only; user update post-commit | OK |
| `sessions::slide_session_activity` | two autocommit statements | OK |
| `sessions::mark_session_reverified` | one session statement | OK |
| `retention::sweep_with_budget` | each operation and each batch is its own transaction: advisory→one table, with a `(time, key)` keyset cursor passed between batches | OK (fixed) |
| `retention::delete_sessions` | advisory→clients (ordered, `SKIP LOCKED`)→sign_ups (ordered)→sign_ins (ordered)→sessions (ordered); clears pointers then deletes; the cursor advances past a fully busy page so later sessions still drain | OK (fixed) |
| `retention::delete_verifications` | advisory→verifications: candidate page without a lock, then `ORDER BY id FOR UPDATE SKIP LOCKED`; cursor advances past busy rows | OK (fixed) |
| `retention::delete_oauth_grants` | advisory→family advisory (sorted)→oauth_grants; cursor advances past busy rows | OK (fixed) |
| `retention::delete_simple` (device_codes, oauth_states, sign_ins, sign_ups, clients, webhook_*, audit_logs, uploads) | advisory→one table: candidate page without a lock, then `ORDER BY key FOR UPDATE SKIP LOCKED`; cursor advances past busy rows; a batch with no further candidates ends the operation | OK (fixed) |
| `retention::expire_stale_sessions` | advisory→clients→sessions→grant families→`webhook_events` inserts | OK (fixed) |
| `orgs::on_user_deleted_on` | orgs (including request organizations, sorted, locked)→membership requests→memberships (ordered)→uploads | OK (fixed) |
| `orgs::delete_organization_on` | members' users `FOR UPDATE` (ascending; members re-read under the organization lock)→org→memberships (ordered)→invitations (ordered)→membership requests (ordered)→grant families→uploads→`organizations` delete | OK (fixed) |
| `orgs::leave_organization_on` | user (`FOR UPDATE`)→organization→memberships (ordered)→grants (the user lock serializes with token issuance, see above) | OK (fixed). Test: `orbitid-identity/tests/lock_order_orgs.rs` |
| `orgs::create_membership_request_on` | user key-share (FK rank 3)→organization→membership request | OK (fixed) |
| `orgs::accept_membership_request_on` | user key-share→organization→membership request→membership insert→status | OK (fixed) |
| `orgs::reject_membership_request_on` | organization→membership request | OK (fixed) |
| `orgs::accept_invitation_on` / `accept_invitation` | user key-share→organization→invitation→membership insert | OK (fixed) |
| `orgs::revoke_organization_invitation_on` | organization→invitation | OK (fixed) |
| `orgs::create_organization_invitation_on` | organization (via `MembershipWriteLock`)→membership/invitation reads→invitation insert→`webhook_events` | OK |
| `orgs::enrollment` (`on_user_email_verified_on`) | candidate = this user only: unlocked reads→user key-share (skips a vanished user)→organizations (sorted)→invitations→revalidate→membership inserts; retried with `with_retry`, failure logged | OK (fixed) |
| `orgs::enrollment_worker` (`enroll_pending_chunk`), `orgs::apply_domain_enrollment` / `enroll_candidates_on` | one short transaction per chunk of 200: per-domain advisory try-lock (no waiter, so no rank)→unlocked keyset page (indexed, no membership anti-join)→users key-share ascending (vanished users skipped)→organization `FOR UPDATE`→revalidate domain + eligibility under the locks→capacity counted once→membership inserts for covered users only→cursor/marker update on the domain row (rank 9, after the organization). The marker (`enrollment_pending_since`) is written in the transaction that verifies/switches the domain; the request path runs one small chunk and wakes the worker | OK (fixed) |
| `orgs::add_membership_on` | requires `MembershipWriteLock`: user key-share→organization `FOR UPDATE`→membership→event | OK (fixed) |
| `rbac::roles` / `custom_permissions` / `orgs::mod` | roles/permissions (ordered) | OK |
| `rbac::is_last_admin_on` | memberships (ordered)→roles/permissions reads | OK |
| `user_roles::set_user_roles_on` | user (`lock_user_on`)→user_roles | OK (fixed) |
| `grants::revoke_grants_for_*` | family advisory (sorted)→oauth_grants | OK |
| `grants::revoke_organization_authority_grants*` | caller's user `FOR UPDATE` (rank 3)→oauth_grants; no family locks | OK (fixed) |
| `verifications::*` | verifications only | OK |
| `uploads::*` | uploads (ordered by file) | OK |
| `external_identity::link_external_account_on` | user→external_accounts (`FOR UPDATE`; the table is not insert-only) | OK |
| `external_identity::delete_external_account_on` | user→external_accounts | OK |
| `api_keys::*`, `restrictions::*`, `org_domains::*` | one table | OK |
| `fapi-auth signin` first-factor code attempt (incl. `reset_password_*_code`), second-factor attempt, first/second-factor prepare (code, link, passkey challenge) | client→user (attempts)→`lock_sign_in_on` (`sign_ins` `FOR UPDATE`)→verifications (check/issue/challenge)→version-CAS `sign_ins` write→sessions; a refused code commits its attempt increment | OK |
| `fapi-auth signin::reset` (`reset_password`) | client→user→sign_ins (CAS claim)→verifications (consume)→users→sessions/grants/trusted devices→sign_ins | OK |
| `fapi-auth verify_link` (`/v1/verify`) | client→user (sign-in links) / claim-owner users of the link's email, ascending (sign-up links)→`lock_sign_in_on` / `lock_sign_up_on`→verifications (`consume_link_on`)→the attempt-row CAS write→(sign-up) new user (`complete_sign_up_on` reuses the held owner locks)→sessions | OK (fixed: owners were locked after `sign_ups`) |
| `fapi-auth attempt_password`, `client::first_factor` / `client::second_factor` (session re-verification) | client→user→sign_ins→sessions; the re-verification paths write `verifications` (owner = a session) but never a `sign_ins`/`sign_ups` row | OK |
| `fapi-auth signin::complete_sign_in(_on)` | client→user→sign_ins→sessions | OK |
| `fapi-auth signup routes` (anonymous/POST/PATCH) | client→sign_ups→user→sessions | OK |
| `fapi-auth signup::verification` (`prepare`, `attempt`) | `prepare`: client→`lock_sign_up_on`→verifications (issue); `attempt`: client→claim-owner users of the sign-up's email, ascending (rank 3, plain read, locked before `sign_ups`)→`lock_sign_up_on`→verifications (check)→version-CAS `sign_ups` write→`complete_sign_up_on` (given the held owners via `prelocked_owners`, so it does not lock again)→user→sessions; a refused code commits its attempt increment | OK (fixed: the owners were locked after `sign_ups`) |
| `fapi-auth signup::complete_sign_up_on` | client→existing claim-owner users `FOR UPDATE` ascending (rank 3, owners read plainly from the validated snapshot, only for a verified email; callers already holding `sign_ups` pass them pre-locked via `prelocked_owners`)→sign_ups→new user (invisible to others; `create_user_claims_locked_on` reuses the held owner locks)→sign_ups/sign_ins (siblings)→sessions | OK (fixed: owners were locked after the sign-up row, a 4→3 inversion) |
| `fapi-auth external_signin` | client→user→sign_ups/sign_ins→sessions | OK |
| `fapi-auth external` | client→external_accounts→users | OK |
| `fapi-account me/profile` (delete self, password) | client(s)→user→… | OK |
| `fapi-account me/profile` (update) | user `FOR UPDATE`; every written column derives from that locked read→email/phone `FOR SHARE`→users→event | OK (fixed) |
| `fapi-account me/mfa` | client→user→sessions | OK |
| `fapi-account me/identifiers/phone` (update, verification attempt) | update: client→user→phone row→sibling phone rows→users→sessions; attempt: user→verification→phone row→users | OK (fixed: update locked the phone and its siblings before the user; the attempt wrote the verification before the user). Test: `fapi-account/tests/concurrency.rs` |
| `fapi-account me/identifiers/*`, `profile_image` | user→child/upload rows | OK |
| `fapi-account me/passkeys` (rename, delete) | user→passkey row | OK (fixed: the passkey row was written without the user lock) |
| `fapi-account me/passkeys` (finish registration) | user key-share→challenge claim (verification)→passkey insert | OK (fixed) |
| `fapi-auth external_signin::complete_sign_up_for_existing_user` | client→user→sign_ups→link→sign_ins→sessions | OK (fixed) |
| `fapi-account orgs/*` | user key-share (membership update/delete: user `FOR UPDATE`)→organization→memberships/invitations/requests/domains (verification→organization for domain attempts and mode changes; enrollment after commit)→grants | OK (fixed) |
| `bapi users/*` (create/update/roles/moderation/images) | user→sessions/images; metadata merges from the row read under the user lock | OK (fixed) |
| `bapi org_backend/memberships` (create/update/remove/metadata) | create/metadata: user key-share→organization→memberships (ordered); update/remove: user `FOR UPDATE`→organization→memberships (ordered)→grants | OK (fixed) |
| `bapi org_backend/invitations` (revoke) | organization→invitation | OK (fixed) |
| `bapi org_backend/organizations`, `domains`, `roles` | organization read/lock under `FOR UPDATE`; domain attempts verification→organization→domains (enrollment after commit)→grants→uploads | OK (fixed) |
| `bapi org_backend/requests` | user key-share→organization→membership request→membership insert | OK (fixed) |
| `bapi invitations`, `waitlist`, `enterprise`, `jwt_templates`, `identifiers`, `webhooks` | one instance-level row or one table / insert-only | OK |
| `oidc tokens` (code exchange) | user key-share (`key_share_active_user_on`, banned and organization authority re-checked under it)→code grant row→new grants (family) | OK (fixed) |
| `oidc refresh` | user key-share (banned and organization authority re-checked)→family advisory→oauth_grants | OK (fixed) |
| `oidc consent` (`record_consent_on` + code issue) | user key-share→consent row→grant insert | OK (fixed) |
| `oidc device` (approval, token poll) | user key-share (the poll re-checks the authority)→device row→grant inserts | OK (fixed) |
| `oidc revocation`, `api_keys` | advisory→oauth_grants / one table | OK |
| `credentials::keys` | signing-key advisory→signing_keys | OK |
| `core::settings` | instance only | OK |
| `platform webhooks` | `FOR UPDATE SKIP LOCKED` claim, deliveries | OK |
| `server::transfer::import` | one destination row/table per statement inside the import transaction | OK |

## Request-level retry (defence in depth)

Postgres `40P01` (deadlock) and `40001` (serialization failure) are mapped to a
409 `transaction_conflict` with a `RetryableTransactionConflict` response
extension. `orbitid-server::retry` sits inside authentication, CSRF and the body
cap, so a replay re-executes only the route handler. It replays at most 3
attempts with jittered backoff, and only when:

* the method is `POST`, `PATCH`, `PUT` or `DELETE`;
* the response is the 409 carrying that extension;
* the body is at most 1 MiB (uploads stream through unretried and are excluded
  by path);
* the path is not `/v1/oauth_callback`, `/v1/client/enterprise`, `/v1/saml` or
  `/v1/client/oauth`, which exchange a one-time external code before their
  transaction.

Every external effect is post-commit (mail/SMS, webhook events, verified-email
enrolment), so it runs only after a successful attempt. Replay-safe state lives
in the request-private `orbitid_core::http::replay` scope:

* the CAPTCHA token that a verifier already accepted is memoized for the
  lifetime of the original request, so a replay never submits the same
  single-use token again (which would turn a valid request into
  `bot_detected`);
* the failed-attempt counter records on a replay only when an earlier attempt
  did **not** already commit it, so a wrong guess is never lost and never
  counted twice;
* the per-code attempt counter is memoized (keyed on the verification id read
  *before* the attempt) only after a real commit. `check_code_on` returns a
  `CodeCheck`: `Verified`, or `Refused` carrying the id whose increment
  was executed; a database failure is the `Err` and is never marked.
  `commit_code_refusal` is the one helper that commits a refusal and then marks,
  and every call site (sign-up/sign-in/reverification, add email/phone, both
  domain-affiliation handlers) uses it. A transaction that is aborted by a
  `40001`/`40P01` is dropped, never committed (Postgres answers `COMMIT` on an
  aborted transaction with `ROLLBACK` and no error);
* the distributed rate-limit budget checks the replay flag and does not consume
  a second unit.

After the last attempt the 409 is returned unchanged. `orbitid_core::db::with_retry`
exposes the same bounded transaction retry; retention and anonymous cleanup use
it for each batch/candidate so a worker retries a transient conflict within the
same tick instead of waiting for the next one.
