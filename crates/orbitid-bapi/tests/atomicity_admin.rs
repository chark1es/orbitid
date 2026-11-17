//! Atomicity tests for the Backend API handlers converted to one transaction
//! per request: a failure injected after the first write must leave nothing
//! behind (including no webhook event), and concurrent check-then-write
//! requests must resolve to exactly one winner and a 409/422 loser.

mod common;

use axum::http::StatusCode;
use common::{setup, Harness};
use orbitid_core::AppState;
use serde_json::{json, Value};

/// Raises inside `operation` (`INSERT`/`UPDATE`/`DELETE`) on `table`.
async fn fail_on(state: &AppState, table: &str, operation: &str) {
    let function = format!("orbitid_test_fail_{table}");
    sqlx::query(&format!(
        "CREATE OR REPLACE FUNCTION {function}() RETURNS trigger AS $$ \
         BEGIN RAISE EXCEPTION 'injected {table} failure'; END; $$ LANGUAGE plpgsql"
    ))
    .execute(&state.pool)
    .await
    .expect("function");
    sqlx::query(&format!(
        "CREATE TRIGGER orbitid_test_fail_{table}_{operation} BEFORE {operation} ON {table} \
         FOR EACH ROW EXECUTE FUNCTION {function}()"
    ))
    .execute(&state.pool)
    .await
    .expect("trigger");
}

/// Raises inside `operation` on `table` only when `column` equals `value`.
async fn fail_when(
    state: &AppState,
    table: &str,
    operation: &str,
    column: &str,
    value: &str,
    tag: &str,
) {
    let function = format!("orbitid_test_fail_{tag}");
    sqlx::query(&format!(
        "CREATE OR REPLACE FUNCTION {function}() RETURNS trigger AS $$ \
         BEGIN IF NEW.{column} = '{value}' THEN RAISE EXCEPTION 'injected {tag} failure'; END IF; \
         RETURN NEW; END; $$ LANGUAGE plpgsql"
    ))
    .execute(&state.pool)
    .await
    .expect("function");
    sqlx::query(&format!(
        "CREATE TRIGGER orbitid_test_fail_{tag} BEFORE {operation} ON {table} \
         FOR EACH ROW EXECUTE FUNCTION {function}()"
    ))
    .execute(&state.pool)
    .await
    .expect("trigger");
}

async fn count(state: &AppState, sql: &str) -> i64 {
    sqlx::query_scalar(sql)
        .fetch_one(&state.pool)
        .await
        .expect("count")
}

async fn count_for(state: &AppState, sql: &str, bind: &str) -> i64 {
    sqlx::query_scalar(sql)
        .bind(bind)
        .fetch_one(&state.pool)
        .await
        .expect("count")
}

async fn create_user(harness: &Harness, email: &str) -> Value {
    let response = harness
        .post(
            "/v1/users",
            json!({ "email_address": [email], "password": "Sup3r-secret!" }),
        )
        .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    response.value()
}

async fn create_org(harness: &Harness, creator: &str) -> String {
    let response = harness
        .post(
            "/v1/organizations",
            json!({ "name": "Atomic Corp", "created_by": creator }),
        )
        .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    response.value()["id"].as_str().expect("org id").to_string()
}

async fn create_domain(harness: &Harness, org_id: &str) -> String {
    let response = harness
        .post(
            &format!("/v1/organizations/{org_id}/domains"),
            json!({ "name": "atomic.test" }),
        )
        .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    response.value()["id"]
        .as_str()
        .expect("domain id")
        .to_string()
}

fn id_of(value: &Value) -> String {
    value["id"].as_str().expect("id").to_string()
}

// ───────────── users ─────────────

#[tokio::test]
async fn user_deletion_rolls_back_when_its_event_fails() {
    let harness = setup().await;
    let user = create_user(&harness, "delete-rollback@example.com").await;
    let id = id_of(&user);
    fail_on(harness.state(), "webhook_events", "INSERT").await;

    let response = harness.delete(&format!("/v1/users/{id}")).await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        count(harness.state(), "SELECT COUNT(*) FROM users").await,
        1,
        "the user must survive the rollback"
    );
}

#[tokio::test]
async fn ban_rolls_back_the_flag_and_the_session_revocation() {
    let harness = setup().await;
    let user = create_user(&harness, "ban-rollback@example.com").await;
    let id = id_of(&user);
    let session = harness.create_session(&id).await;
    fail_on(harness.state(), "sessions", "UPDATE").await;

    let response = harness.post_empty(&format!("/v1/users/{id}/ban")).await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    let banned: bool = sqlx::query_scalar("SELECT banned FROM users WHERE id = $1")
        .bind(&id)
        .fetch_one(&harness.state().pool)
        .await
        .expect("user");
    assert!(!banned, "the ban flag must roll back");
    let status: String = sqlx::query_scalar("SELECT status FROM sessions WHERE id = $1")
        .bind(&session.session_id)
        .fetch_one(&harness.state().pool)
        .await
        .expect("session");
    assert_eq!(status, "active");
}

#[tokio::test]
async fn user_role_assignment_rolls_back() {
    let harness = setup().await;
    let user = create_user(&harness, "roles-rollback@example.com").await;
    let id = id_of(&user);
    let role = harness
        .post(
            "/v1/roles",
            json!({ "key": "app:rollback", "name": "Rollback" }),
        )
        .await;
    assert_eq!(role.status, StatusCode::OK, "{}", role.text());
    fail_on(harness.state(), "user_roles", "INSERT").await;

    let response = harness
        .put(
            &format!("/v1/users/{id}/roles"),
            json!({ "roles": ["app:rollback"] }),
        )
        .await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        count(harness.state(), "SELECT COUNT(*) FROM user_roles").await,
        0
    );
    let events = count(
        harness.state(),
        "SELECT COUNT(*) FROM webhook_events WHERE type = 'user.updated'",
    )
    .await;
    assert_eq!(events, 0);
}

// ───────────── instance invitations ─────────────

#[tokio::test]
async fn invitation_creation_rolls_back_when_its_event_fails() {
    let harness = setup().await;
    fail_on(harness.state(), "webhook_events", "INSERT").await;
    let response = harness
        .post(
            "/v1/invitations",
            json!({ "email_address": "invite-rollback@example.com", "notify": false }),
        )
        .await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        count(harness.state(), "SELECT COUNT(*) FROM invitations").await,
        0
    );
}

#[tokio::test]
async fn invitation_revoke_rolls_back() {
    let harness = setup().await;
    let created = harness
        .post(
            "/v1/invitations",
            json!({ "email_address": "revoke-rollback@example.com", "notify": false }),
        )
        .await;
    let id = id_of(&created.value());
    fail_on(harness.state(), "webhook_events", "INSERT").await;
    let response = harness
        .post_empty(&format!("/v1/invitations/{id}/revoke"))
        .await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    let status: String = sqlx::query_scalar("SELECT status FROM invitations WHERE id = $1")
        .bind(&id)
        .fetch_one(&harness.state().pool)
        .await
        .expect("invitation");
    assert_eq!(status, "pending");
}

#[tokio::test]
async fn bulk_invitations_are_all_or_nothing() {
    let harness = setup().await;
    fail_when(
        harness.state(),
        "invitations",
        "INSERT",
        "email",
        "two@example.com",
        "invitations_two",
    )
    .await;
    let response = harness
        .post(
            "/v1/invitations/bulk",
            json!({
                "email_addresses": ["one@example.com", "two@example.com"],
                "notify": false
            }),
        )
        .await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        count(harness.state(), "SELECT COUNT(*) FROM invitations").await,
        0,
        "the first insert of the batch must roll back too"
    );
}

// ───────────── waitlist ─────────────

#[tokio::test]
async fn waitlist_creation_rolls_back() {
    let harness = setup().await;
    fail_on(harness.state(), "webhook_events", "INSERT").await;
    let response = harness
        .post(
            "/v1/waitlist_entries",
            json!({ "email_address": "waitlist-rollback@example.com" }),
        )
        .await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        count(harness.state(), "SELECT COUNT(*) FROM waitlist_entries").await,
        0
    );
}

#[tokio::test]
async fn waitlist_invite_rolls_back_the_invitation_and_status() {
    let harness = setup().await;
    let entry = harness
        .post(
            "/v1/waitlist_entries",
            json!({ "email_address": "waitlist-invite@example.com" }),
        )
        .await;
    let id = id_of(&entry.value());
    fail_on(harness.state(), "webhook_events", "INSERT").await;
    let response = harness
        .post_empty(&format!("/v1/waitlist_entries/{id}/invite"))
        .await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        count(harness.state(), "SELECT COUNT(*) FROM invitations").await,
        0
    );
    let status: String = sqlx::query_scalar("SELECT status FROM waitlist_entries WHERE id = $1")
        .bind(&id)
        .fetch_one(&harness.state().pool)
        .await
        .expect("entry");
    assert_eq!(status, "pending");
}

#[tokio::test]
async fn waitlist_reject_rolls_back() {
    let harness = setup().await;
    let entry = harness
        .post(
            "/v1/waitlist_entries",
            json!({ "email_address": "waitlist-reject@example.com" }),
        )
        .await;
    let id = id_of(&entry.value());
    fail_on(harness.state(), "webhook_events", "INSERT").await;
    let response = harness
        .post_empty(&format!("/v1/waitlist_entries/{id}/reject"))
        .await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    let status: String = sqlx::query_scalar("SELECT status FROM waitlist_entries WHERE id = $1")
        .bind(&id)
        .fetch_one(&harness.state().pool)
        .await
        .expect("entry");
    assert_eq!(status, "pending");
}

// ───────────── allowlist / blocklist ─────────────

#[tokio::test]
async fn allowlist_creation_rolls_back_its_invitation() {
    let harness = setup().await;
    fail_on(harness.state(), "allowlist_identifiers", "INSERT").await;
    let response = harness
        .post(
            "/v1/allowlist_identifiers",
            json!({ "identifier": "allow-rollback@example.com", "notify": true }),
        )
        .await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        count(
            harness.state(),
            "SELECT COUNT(*) FROM allowlist_identifiers"
        )
        .await,
        0
    );
    assert_eq!(
        count(harness.state(), "SELECT COUNT(*) FROM invitations").await,
        0,
        "the invitation created for the allowlist notice must roll back"
    );
}

// ───────────── organization domains ─────────────

#[tokio::test]
async fn domain_creation_rolls_back_when_its_event_fails() {
    let harness = setup().await;
    let owner = create_user(&harness, "domain-owner@example.com").await;
    let org_id = create_org(&harness, &id_of(&owner)).await;
    fail_on(harness.state(), "webhook_events", "INSERT").await;
    let response = harness
        .post(
            &format!("/v1/organizations/{org_id}/domains"),
            json!({ "name": "rollback.test" }),
        )
        .await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        count(harness.state(), "SELECT COUNT(*) FROM organization_domains").await,
        0
    );
}

#[tokio::test]
async fn domain_update_rolls_back_mode_and_pending_invitation_deletion() {
    let harness = setup().await;
    let owner = create_user(&harness, "domain-update@example.com").await;
    let org_id = create_org(&harness, &id_of(&owner)).await;
    let domain_id = create_domain(&harness, &org_id).await;
    fail_on(harness.state(), "webhook_events", "INSERT").await;
    let response = harness
        .patch(
            &format!("/v1/organizations/{org_id}/domains/{domain_id}"),
            json!({ "enrollment_mode": "automatic_suggestion", "delete_pending": true }),
        )
        .await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    let mode: String =
        sqlx::query_scalar("SELECT enrollment_mode FROM organization_domains WHERE id = $1")
            .bind(&domain_id)
            .fetch_one(&harness.state().pool)
            .await
            .expect("domain");
    assert_eq!(mode, "manual_invitation");
}

#[tokio::test]
async fn affiliation_prepare_rolls_back_the_verification() {
    let harness = setup().await;
    let owner = create_user(&harness, "affiliation@example.com").await;
    let org_id = create_org(&harness, &id_of(&owner)).await;
    let domain_id = create_domain(&harness, &org_id).await;
    fail_on(harness.state(), "organization_domains", "UPDATE").await;
    let response = harness
        .post(
            &format!(
                "/v1/organizations/{org_id}/domains/{domain_id}/prepare_affiliation_verification"
            ),
            json!({ "affiliation_email_address": "owner@atomic.test" }),
        )
        .await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        count(
            harness.state(),
            "SELECT COUNT(*) FROM verifications WHERE purpose = 'org_domain'"
        )
        .await,
        0,
        "the verification issued before the failed update must roll back"
    );
}

#[tokio::test]
async fn affiliation_attempt_rolls_back_verification_and_domain() {
    let harness = setup().await;
    let owner = create_user(&harness, "attempt@example.com").await;
    let org_id = create_org(&harness, &id_of(&owner)).await;
    let domain_id = create_domain(&harness, &org_id).await;
    let code_hash =
        orbitid_core::crypto::hash_low_entropy(&harness.state().env.encryption_key, "123456");
    let now = orbitid_core::http::now();
    sqlx::query(
        "INSERT INTO verifications (id, purpose, strategy, identifier, owner_id, code_hash, \
         attempts, max_attempts, expires_at, created_at) \
         VALUES ($1,'org_domain','email_code','owner@atomic.test',$2,$3,0,5,$4,$5)",
    )
    .bind(orbitid_core::ids::new_id(
        orbitid_core::ids::id_prefix::VERIFICATION,
    ))
    .bind(&domain_id)
    .bind(&code_hash)
    .bind(now + 600_000)
    .bind(now)
    .execute(&harness.state().pool)
    .await
    .expect("verification");
    fail_on(harness.state(), "webhook_events", "INSERT").await;

    let response = harness
        .post(
            &format!(
                "/v1/organizations/{org_id}/domains/{domain_id}/attempt_affiliation_verification"
            ),
            json!({ "code": "123456" }),
        )
        .await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    let verified: bool =
        sqlx::query_scalar("SELECT verified FROM organization_domains WHERE id = $1")
            .bind(&domain_id)
            .fetch_one(&harness.state().pool)
            .await
            .expect("domain");
    assert!(!verified, "the domain must not stay verified");
    let consumed: Option<i64> =
        sqlx::query_scalar("SELECT consumed_at FROM verifications WHERE owner_id = $1")
            .bind(&domain_id)
            .fetch_one(&harness.state().pool)
            .await
            .expect("verification");
    assert!(
        consumed.is_none(),
        "the verification must not stay consumed"
    );
}

#[tokio::test]
async fn domain_deletion_rolls_back() {
    let harness = setup().await;
    let owner = create_user(&harness, "domain-delete@example.com").await;
    let org_id = create_org(&harness, &id_of(&owner)).await;
    let domain_id = create_domain(&harness, &org_id).await;
    fail_on(harness.state(), "webhook_events", "INSERT").await;
    let response = harness
        .delete(&format!("/v1/organizations/{org_id}/domains/{domain_id}"))
        .await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        count(harness.state(), "SELECT COUNT(*) FROM organization_domains").await,
        1
    );
}

// ───────────── organization requests / invitations ─────────────

#[tokio::test]
async fn membership_request_accept_rolls_back_the_membership() {
    let harness = setup().await;
    let owner = create_user(&harness, "request-owner@example.com").await;
    let candidate = create_user(&harness, "request-candidate@example.com").await;
    let org_id = create_org(&harness, &id_of(&owner)).await;
    let request = harness
        .post(
            &format!("/v1/organizations/{org_id}/membership_requests"),
            json!({ "user_id": id_of(&candidate) }),
        )
        .await;
    assert_eq!(request.status, StatusCode::OK, "{}", request.text());
    let request_id = id_of(&request.value());
    fail_on(
        harness.state(),
        "organization_membership_requests",
        "UPDATE",
    )
    .await;

    let response = harness
        .post_empty(&format!(
            "/v1/organizations/{org_id}/membership_requests/{request_id}/accept"
        ))
        .await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        count_for(
            harness.state(),
            "SELECT COUNT(*) FROM organization_memberships WHERE user_id = $1",
            &id_of(&candidate),
        )
        .await,
        0
    );
    let status: String =
        sqlx::query_scalar("SELECT status FROM organization_membership_requests WHERE id = $1")
            .bind(&request_id)
            .fetch_one(&harness.state().pool)
            .await
            .expect("request");
    assert_eq!(status, "pending");
}

#[tokio::test]
async fn organization_bulk_invitations_are_all_or_nothing() {
    let harness = setup().await;
    let owner = create_user(&harness, "org-bulk@example.com").await;
    let org_id = create_org(&harness, &id_of(&owner)).await;
    fail_when(
        harness.state(),
        "organization_invitations",
        "INSERT",
        "email",
        "two@example.com",
        "org_invitations_two",
    )
    .await;
    let response = harness
        .post(
            &format!("/v1/organizations/{org_id}/invitations/bulk"),
            json!({ "email_addresses": ["one@example.com", "two@example.com"] }),
        )
        .await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        count(
            harness.state(),
            "SELECT COUNT(*) FROM organization_invitations"
        )
        .await,
        0
    );
}

#[tokio::test]
async fn organization_invitation_revoke_rolls_back() {
    let harness = setup().await;
    let owner = create_user(&harness, "org-revoke@example.com").await;
    let org_id = create_org(&harness, &id_of(&owner)).await;
    let invitation = harness
        .post(
            &format!("/v1/organizations/{org_id}/invitations"),
            json!({ "email_address": "invitee@example.com" }),
        )
        .await;
    assert_eq!(invitation.status, StatusCode::OK, "{}", invitation.text());
    let invitation_id = id_of(&invitation.value());
    fail_on(harness.state(), "webhook_events", "INSERT").await;
    let response = harness
        .post_empty(&format!(
            "/v1/organizations/{org_id}/invitations/{invitation_id}/revoke"
        ))
        .await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    let status: String =
        sqlx::query_scalar("SELECT status FROM organization_invitations WHERE id = $1")
            .bind(&invitation_id)
            .fetch_one(&harness.state().pool)
            .await
            .expect("invitation");
    assert_eq!(status, "pending");
}

// ───────────── organizations ─────────────

#[tokio::test]
async fn organization_update_rolls_back() {
    let harness = setup().await;
    let owner = create_user(&harness, "org-update@example.com").await;
    let org_id = create_org(&harness, &id_of(&owner)).await;
    fail_on(harness.state(), "webhook_events", "INSERT").await;
    let response = harness
        .patch(
            &format!("/v1/organizations/{org_id}"),
            json!({ "name": "Renamed Corp" }),
        )
        .await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    let name: String = sqlx::query_scalar("SELECT name FROM organizations WHERE id = $1")
        .bind(&org_id)
        .fetch_one(&harness.state().pool)
        .await
        .expect("org");
    assert_eq!(name, "Atomic Corp");
}

#[tokio::test]
async fn organization_deletion_rolls_back() {
    let harness = setup().await;
    let owner = create_user(&harness, "org-delete@example.com").await;
    let org_id = create_org(&harness, &id_of(&owner)).await;
    fail_on(harness.state(), "webhook_events", "INSERT").await;
    let response = harness.delete(&format!("/v1/organizations/{org_id}")).await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        count(harness.state(), "SELECT COUNT(*) FROM organizations").await,
        1,
        "the organization must survive the rollback"
    );
}

// ───────────── roles / permissions ─────────────

#[tokio::test]
async fn role_creation_rolls_back() {
    let harness = setup().await;
    fail_on(harness.state(), "webhook_events", "INSERT").await;
    let response = harness
        .post(
            "/v1/roles",
            json!({ "key": "org:rollback", "name": "Rollback" }),
        )
        .await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        count(
            harness.state(),
            "SELECT COUNT(*) FROM roles WHERE key = 'org:rollback'"
        )
        .await,
        0
    );
}

#[tokio::test]
async fn role_update_rolls_back() {
    let harness = setup().await;
    let created = harness
        .post(
            "/v1/roles",
            json!({ "key": "org:rollback", "name": "Rollback" }),
        )
        .await;
    let id = id_of(&created.value());
    fail_on(harness.state(), "webhook_events", "INSERT").await;
    let response = harness
        .patch(&format!("/v1/roles/{id}"), json!({ "name": "Renamed" }))
        .await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    let name: String = sqlx::query_scalar("SELECT name FROM roles WHERE id = $1")
        .bind(&id)
        .fetch_one(&harness.state().pool)
        .await
        .expect("role");
    assert_eq!(name, "Rollback");
}

#[tokio::test]
async fn role_deletion_rolls_back() {
    let harness = setup().await;
    let created = harness
        .post(
            "/v1/roles",
            json!({ "key": "org:rollback", "name": "Rollback" }),
        )
        .await;
    let id = id_of(&created.value());
    fail_on(harness.state(), "webhook_events", "INSERT").await;
    let response = harness.delete(&format!("/v1/roles/{id}")).await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        count(
            harness.state(),
            "SELECT COUNT(*) FROM roles WHERE key = 'org:rollback'"
        )
        .await,
        1
    );
}

#[tokio::test]
async fn permission_create_update_and_delete_roll_back() {
    let harness = setup().await;
    fail_on(harness.state(), "webhook_events", "INSERT").await;
    let created = harness
        .post(
            "/v1/permissions",
            json!({ "key": "org:rollback:manage", "name": "Rollback" }),
        )
        .await;
    assert_eq!(created.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        count(
            harness.state(),
            "SELECT COUNT(*) FROM permissions WHERE key = 'org:rollback:manage'"
        )
        .await,
        0
    );
}

#[tokio::test]
async fn permission_update_and_delete_roll_back() {
    let harness = setup().await;
    let created = harness
        .post(
            "/v1/permissions",
            json!({ "key": "org:rollback:manage", "name": "Rollback" }),
        )
        .await;
    assert_eq!(created.status, StatusCode::OK, "{}", created.text());
    let id = id_of(&created.value());
    fail_on(harness.state(), "webhook_events", "INSERT").await;

    let update = harness
        .patch(
            &format!("/v1/permissions/{id}"),
            json!({ "name": "Renamed" }),
        )
        .await;
    assert_eq!(update.status, StatusCode::INTERNAL_SERVER_ERROR);
    let name: String = sqlx::query_scalar("SELECT name FROM permissions WHERE id = $1")
        .bind(&id)
        .fetch_one(&harness.state().pool)
        .await
        .expect("permission");
    assert_eq!(name, "Rollback");

    let delete = harness.delete(&format!("/v1/permissions/{id}")).await;
    assert_eq!(delete.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        count(
            harness.state(),
            "SELECT COUNT(*) FROM permissions WHERE key = 'org:rollback:manage'"
        )
        .await,
        1
    );
}

#[tokio::test]
async fn role_permission_replacement_rolls_back() {
    let harness = setup().await;
    let created = harness
        .post(
            "/v1/roles",
            json!({ "key": "org:rollback", "name": "Rollback" }),
        )
        .await;
    let id = id_of(&created.value());
    fail_on(harness.state(), "webhook_events", "INSERT").await;
    let response = harness
        .post(
            &format!("/v1/roles/{id}/permissions"),
            json!({ "permissions": ["org:sys_memberships:read"] }),
        )
        .await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        count_for(
            harness.state(),
            "SELECT COUNT(*) FROM role_permissions WHERE role_id = $1",
            &id,
        )
        .await,
        0
    );
}

// ───────────── webhook test delivery ─────────────

#[tokio::test]
async fn webhook_test_event_rolls_back_when_the_delivery_cannot_be_written() {
    let harness = setup().await;
    let endpoint = harness
        .post(
            "/v1/webhooks/endpoints",
            json!({ "url": "http://127.0.0.1:9/hook" }),
        )
        .await;
    assert_eq!(endpoint.status, StatusCode::OK, "{}", endpoint.text());
    let id = id_of(&endpoint.value());
    fail_on(harness.state(), "webhook_deliveries", "INSERT").await;
    let response = harness
        .post_empty(&format!("/v1/webhooks/endpoints/{id}/test"))
        .await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        count(
            harness.state(),
            "SELECT COUNT(*) FROM webhook_events WHERE type = 'user.created'"
        )
        .await,
        0,
        "the test event must roll back with the failed delivery insert"
    );
}

// ───────────── concurrency: check-then-write ─────────────

#[tokio::test]
async fn concurrent_enterprise_domain_claims_allow_exactly_one() {
    let harness = setup().await;
    let body = json!({
        "name": "Concurrent",
        "protocol": "oidc",
        "domains": ["concurrent.test"],
        "active": true,
        "client_id": "client",
        "client_secret": "secret",
        "discovery_url": "https://idp.example.com/.well-known/openid-configuration"
    });
    let (left, right) = tokio::join!(
        harness.post("/v1/enterprise_connections", body.clone()),
        harness.post("/v1/enterprise_connections", body.clone()),
    );
    let statuses = [left.status, right.status];
    assert_eq!(
        statuses
            .iter()
            .filter(|status| **status == StatusCode::CREATED)
            .count(),
        1,
        "exactly one connection may claim the domain: {statuses:?}"
    );
    let loser = if left.status == StatusCode::CREATED {
        &right
    } else {
        &left
    };
    assert_eq!(loser.status, StatusCode::CONFLICT, "{}", loser.text());
    assert_eq!(
        common::error_code(loser).as_deref(),
        Some("duplicate_record")
    );
}

#[tokio::test]
async fn concurrent_jwt_template_names_allow_exactly_one() {
    let harness = setup().await;
    let body = json!({ "name": "concurrent", "lifetime": 60 });
    let (left, right) = tokio::join!(
        harness.post("/v1/jwt_templates", body.clone()),
        harness.post("/v1/jwt_templates", body.clone()),
    );
    let statuses = [left.status, right.status];
    assert_eq!(
        statuses
            .iter()
            .filter(|status| **status == StatusCode::OK)
            .count(),
        1,
        "exactly one template may take the name: {statuses:?}"
    );
    let loser = if left.status == StatusCode::OK {
        &right
    } else {
        &left
    };
    assert!(
        loser.status == StatusCode::UNPROCESSABLE_ENTITY || loser.status == StatusCode::CONFLICT,
        "loser must be 409/422, never a 500: {} {}",
        loser.status,
        loser.text()
    );
}

#[tokio::test]
async fn concurrent_role_keys_allow_exactly_one() {
    let harness = setup().await;
    let body = json!({ "key": "org:concurrent", "name": "Concurrent" });
    let (left, right) = tokio::join!(
        harness.post("/v1/roles", body.clone()),
        harness.post("/v1/roles", body.clone()),
    );
    let statuses = [left.status, right.status];
    assert_eq!(
        statuses
            .iter()
            .filter(|status| **status == StatusCode::OK)
            .count(),
        1,
        "exactly one role may take the key: {statuses:?}"
    );
    let loser = if left.status == StatusCode::OK {
        &right
    } else {
        &left
    };
    assert!(
        loser.status == StatusCode::CONFLICT || loser.status == StatusCode::UNPROCESSABLE_ENTITY,
        "loser must be 409/422, never a 500: {} {}",
        loser.status,
        loser.text()
    );
}

#[tokio::test]
async fn concurrent_waitlist_entries_allow_exactly_one() {
    let harness = setup().await;
    let body = json!({ "email_address": "concurrent-waitlist@example.com" });
    let (left, right) = tokio::join!(
        harness.post("/v1/waitlist_entries", body.clone()),
        harness.post("/v1/waitlist_entries", body.clone()),
    );
    let wins = [&left, &right]
        .iter()
        .filter(|response| response.status == StatusCode::OK)
        .count();
    assert_eq!(wins, 1, "exactly one waitlist entry may be created");
    let loser = if left.status == StatusCode::OK {
        &right
    } else {
        &left
    };
    assert!(
        loser.status == StatusCode::UNPROCESSABLE_ENTITY || loser.status == StatusCode::CONFLICT,
        "loser must be 409/422, never a 500: {} {}",
        loser.status,
        loser.text()
    );
}

// ───────────── additional conversions ─────────────

#[tokio::test]
async fn organization_metadata_update_rolls_back() {
    let harness = setup().await;
    let owner = create_user(&harness, "org-metadata@example.com").await;
    let org_id = create_org(&harness, &id_of(&owner)).await;
    fail_on(harness.state(), "webhook_events", "INSERT").await;
    let response = harness
        .patch(
            &format!("/v1/organizations/{org_id}/metadata"),
            json!({ "public_metadata": { "tier": "pro" } }),
        )
        .await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    let public: Value =
        sqlx::query_scalar("SELECT public_metadata FROM organizations WHERE id = $1")
            .bind(&org_id)
            .fetch_one(&harness.state().pool)
            .await
            .expect("org");
    assert_eq!(public, json!({}));
}

#[tokio::test]
async fn organization_logo_pointer_rolls_back() {
    let harness = setup().await;
    let owner = create_user(&harness, "org-logo@example.com").await;
    let org_id = create_org(&harness, &id_of(&owner)).await;
    fail_on(harness.state(), "webhook_events", "INSERT").await;
    let response = harness
        .put(
            &format!("/v1/organizations/{org_id}/logo"),
            json!({
                "file": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
            }),
        )
        .await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    let image: Option<String> =
        sqlx::query_scalar("SELECT image_url FROM organizations WHERE id = $1")
            .bind(&org_id)
            .fetch_one(&harness.state().pool)
            .await
            .expect("org");
    assert!(image.is_none(), "the logo pointer must roll back");
}

#[tokio::test]
async fn role_permission_removal_rolls_back() {
    let harness = setup().await;
    let created = harness
        .post(
            "/v1/roles",
            json!({
                "key": "org:rollback",
                "name": "Rollback",
                "permissions": ["org:sys_memberships:read"]
            }),
        )
        .await;
    assert_eq!(created.status, StatusCode::OK, "{}", created.text());
    let id = id_of(&created.value());
    let permission_id = created.value()["permissions"][0]["id"]
        .as_str()
        .expect("permission id")
        .to_string();
    fail_on(harness.state(), "webhook_events", "INSERT").await;
    let response = harness
        .delete(&format!("/v1/roles/{id}/permissions/{permission_id}"))
        .await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        count_for(
            harness.state(),
            "SELECT COUNT(*) FROM role_permissions WHERE role_id = $1",
            &id,
        )
        .await,
        1
    );
}

#[tokio::test]
async fn user_profile_update_rolls_back() {
    let harness = setup().await;
    let user = create_user(&harness, "profile-rollback@example.com").await;
    let id = id_of(&user);
    fail_on(harness.state(), "webhook_events", "INSERT").await;
    let response = harness
        .patch(
            &format!("/v1/users/{id}"),
            json!({ "first_name": "Changed" }),
        )
        .await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    let first_name: Option<String> =
        sqlx::query_scalar("SELECT first_name FROM users WHERE id = $1")
            .bind(&id)
            .fetch_one(&harness.state().pool)
            .await
            .expect("user");
    assert!(first_name.is_none());
}

#[tokio::test]
async fn profile_image_pointer_rolls_back() {
    let harness = setup().await;
    let user = create_user(&harness, "image-rollback@example.com").await;
    let id = id_of(&user);
    fail_on(harness.state(), "webhook_events", "INSERT").await;
    let response = harness
        .post(
            &format!("/v1/users/{id}/profile_image"),
            json!({
                "file": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
            }),
        )
        .await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    let image: Option<String> = sqlx::query_scalar("SELECT image_url FROM users WHERE id = $1")
        .bind(&id)
        .fetch_one(&harness.state().pool)
        .await
        .expect("user");
    assert!(image.is_none());
}

#[tokio::test]
async fn concurrent_allowlist_entries_allow_exactly_one() {
    let harness = setup().await;
    let body = json!({ "identifier": "allow-race@example.com" });
    let (left, right) = tokio::join!(
        harness.post("/v1/allowlist_identifiers", body.clone()),
        harness.post("/v1/allowlist_identifiers", body.clone()),
    );
    assert_eq!(
        [&left, &right]
            .iter()
            .filter(|response| response.status == StatusCode::OK)
            .count(),
        1,
        "exactly one allowlist entry may be created"
    );
    let loser = if left.status == StatusCode::OK {
        &right
    } else {
        &left
    };
    assert!(
        loser.status == StatusCode::UNPROCESSABLE_ENTITY || loser.status == StatusCode::CONFLICT,
        "loser must be 409/422, never a 500: {} {}",
        loser.status,
        loser.text()
    );
}

#[tokio::test]
async fn concurrent_blocklist_entries_allow_exactly_one() {
    let harness = setup().await;
    let body = json!({ "identifier": "0xfeedface" });
    let (left, right) = tokio::join!(
        harness.post("/v1/blocklist_identifiers", body.clone()),
        harness.post("/v1/blocklist_identifiers", body.clone()),
    );
    assert_eq!(
        [&left, &right]
            .iter()
            .filter(|response| response.status == StatusCode::OK)
            .count(),
        1,
        "exactly one blocklist entry may be created"
    );
    let loser = if left.status == StatusCode::OK {
        &right
    } else {
        &left
    };
    assert!(
        loser.status == StatusCode::UNPROCESSABLE_ENTITY || loser.status == StatusCode::CONFLICT,
        "loser must be 409/422, never a 500: {} {}",
        loser.status,
        loser.text()
    );
}
