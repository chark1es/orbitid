//! Ported from the retired TypeScript test suite (Backend API
//! half: organization changes revoke authority-bearing OIDC grants).

mod common;

use axum::http::StatusCode;
use serde_json::json;

use common::{setup, Harness};

async fn create_user(harness: &Harness) -> String {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let response = harness
        .post(
            "/v1/users",
            json!({ "email_address": [format!("grant-user-{n}@example.com")], "password": "Sup3r-secret!" }),
        )
        .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    response.value()["id"].as_str().unwrap().to_string()
}

async fn create_org(harness: &Harness, owner: &str, name: &str) -> String {
    let response = harness
        .post(
            "/v1/organizations",
            json!({ "name": name, "created_by": owner }),
        )
        .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    response.value()["id"].as_str().unwrap().to_string()
}

async fn seed_application(
    harness: &Harness,
    name: &str,
    scopes: &str,
    groups_claim: &str,
) -> String {
    let id = orbitid_core::ids::new_id("oa");
    let now = orbitid_core::http::now();
    sqlx::query(
        "INSERT INTO oauth_applications (id, name, client_id, redirect_uris, scopes, \
         groups_claim, created_at, updated_at) VALUES ($1,$2,$3,'[]',$4,$5,$6,$6)",
    )
    .bind(&id)
    .bind(name)
    .bind(format!("client-{id}"))
    .bind(scopes)
    .bind(groups_claim)
    .bind(now)
    .execute(&harness.state().pool)
    .await
    .expect("application");
    id
}

async fn seed_grant(harness: &Harness, application_id: &str, user_id: &str, label: &str) -> String {
    let id = orbitid_core::ids::new_id("oag");
    let now = orbitid_core::http::now();
    sqlx::query(
        "INSERT INTO oauth_grants (id, kind, application_id, user_id, token_hash, scopes, \
         family_id, revoked, expires_at, created_at) \
         VALUES ($1,'refresh',$2,$3,$4,'openid',$5,false,$6,$7)",
    )
    .bind(&id)
    .bind(application_id)
    .bind(user_id)
    .bind(format!("hash_{label}_{id}"))
    .bind(format!("family_{label}_{id}"))
    .bind(now + 3_600_000)
    .bind(now)
    .execute(&harness.state().pool)
    .await
    .expect("grant");
    id
}

async fn revoked(harness: &Harness, id: &str) -> bool {
    sqlx::query_scalar("SELECT revoked FROM oauth_grants WHERE id = $1")
        .bind(id)
        .fetch_one(&harness.state().pool)
        .await
        .expect("grant row")
}

async fn fail_grant_updates(harness: &Harness) {
    sqlx::query(
        "CREATE OR REPLACE FUNCTION orbitid_test_fail_grant_update() RETURNS trigger AS $$ \
         BEGIN RAISE EXCEPTION 'injected grant revocation failure'; END; $$ LANGUAGE plpgsql",
    )
    .execute(&harness.state().pool)
    .await
    .expect("function");
    sqlx::query(
        "CREATE TRIGGER orbitid_test_fail_grant_update BEFORE UPDATE ON oauth_grants \
         FOR EACH ROW EXECUTE FUNCTION orbitid_test_fail_grant_update()",
    )
    .execute(&harness.state().pool)
    .await
    .expect("trigger");
}

async fn membership_role(harness: &Harness, org: &str, user: &str) -> String {
    sqlx::query_scalar(
        "SELECT role_key FROM organization_memberships WHERE organization_id = $1 AND user_id = $2",
    )
    .bind(org)
    .bind(user)
    .fetch_one(&harness.state().pool)
    .await
    .expect("membership")
}

#[tokio::test]
async fn membership_removal_revokes_only_authority_bearing_apps() {
    let harness = setup().await;
    let owner = create_user(&harness).await;
    let member = create_user(&harness).await;
    let org = create_org(&harness, &owner, "Acme").await;
    harness
        .post(
            &format!("/v1/organizations/{org}/memberships"),
            json!({ "user_id": member, "role": "org:member" }),
        )
        .await;
    let session = harness.create_session(&member).await;

    let authority =
        seed_application(&harness, "Authority", "openid groups organizations", "all").await;
    let unrelated = seed_application(&harness, "Unrelated", "openid profile email", "all").await;
    let groups_none = seed_application(&harness, "Groups none", "openid groups", "none").await;
    let authority_grant = seed_grant(&harness, &authority, &member, "authority").await;
    let unrelated_grant = seed_grant(&harness, &unrelated, &member, "unrelated").await;
    let none_grant = seed_grant(&harness, &groups_none, &member, "none").await;

    let removed = harness
        .delete(&format!("/v1/organizations/{org}/memberships/{member}"))
        .await;
    assert_eq!(removed.status, StatusCode::OK, "{}", removed.text());

    assert!(revoked(&harness, &authority_grant).await);
    assert!(!revoked(&harness, &unrelated_grant).await);
    assert!(!revoked(&harness, &none_grant).await);
    let status: String = sqlx::query_scalar("SELECT status FROM sessions WHERE id = $1")
        .bind(&session.session_id)
        .fetch_one(&harness.state().pool)
        .await
        .expect("session");
    assert_eq!(status, "active");
}

#[tokio::test]
async fn role_change_and_org_deletion_revoke_grants_without_ending_sessions() {
    let harness = setup().await;
    let owner = create_user(&harness).await;
    let member = create_user(&harness).await;
    let org = create_org(&harness, &owner, "Beta").await;
    harness
        .post(
            &format!("/v1/organizations/{org}/memberships"),
            json!({ "user_id": member, "role": "org:admin" }),
        )
        .await;
    let session = harness.create_session(&member).await;
    let app = seed_application(&harness, "Groups", "openid groups", "all").await;

    let role_grant = seed_grant(&harness, &app, &member, "role-change").await;
    let demoted = harness
        .patch(
            &format!("/v1/organizations/{org}/memberships/{member}"),
            json!({ "role": "org:member" }),
        )
        .await;
    assert_eq!(demoted.status, StatusCode::OK, "{}", demoted.text());
    assert!(revoked(&harness, &role_grant).await);
    let status: String = sqlx::query_scalar("SELECT status FROM sessions WHERE id = $1")
        .bind(&session.session_id)
        .fetch_one(&harness.state().pool)
        .await
        .expect("session");
    assert_eq!(status, "active");

    let deletion_grant = seed_grant(&harness, &app, &member, "org-deletion").await;
    let deleted = harness.delete(&format!("/v1/organizations/{org}")).await;
    assert_eq!(deleted.status, StatusCode::OK, "{}", deleted.text());
    assert!(revoked(&harness, &deletion_grant).await);
    let status: String = sqlx::query_scalar("SELECT status FROM sessions WHERE id = $1")
        .bind(&session.session_id)
        .fetch_one(&harness.state().pool)
        .await
        .expect("session");
    assert_eq!(status, "active");
}

#[tokio::test]
async fn membership_removal_rolls_back_when_grant_revocation_fails() {
    let harness = setup().await;
    let owner = create_user(&harness).await;
    let member = create_user(&harness).await;
    let org = create_org(&harness, &owner, "Rollback remove").await;
    harness
        .post(
            &format!("/v1/organizations/{org}/memberships"),
            json!({ "user_id": member, "role": "org:member" }),
        )
        .await;
    let app = seed_application(&harness, "Rollback groups", "openid groups", "all").await;
    let grant = seed_grant(&harness, &app, &member, "remove-rollback").await;
    fail_grant_updates(&harness).await;

    let removed = harness
        .delete(&format!("/v1/organizations/{org}/memberships/{member}"))
        .await;
    assert_eq!(removed.status, StatusCode::INTERNAL_SERVER_ERROR);
    let still_member: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM organization_memberships WHERE organization_id = $1 AND user_id = $2",
    )
    .bind(&org)
    .bind(&member)
    .fetch_one(&harness.state().pool)
    .await
    .expect("membership");
    assert_eq!(still_member, 1, "the membership must survive the rollback");
    assert!(!revoked(&harness, &grant).await);
}

#[tokio::test]
async fn role_change_rolls_back_when_grant_revocation_fails() {
    let harness = setup().await;
    let owner = create_user(&harness).await;
    let member = create_user(&harness).await;
    let org = create_org(&harness, &owner, "Rollback role").await;
    harness
        .post(
            &format!("/v1/organizations/{org}/memberships"),
            json!({ "user_id": member, "role": "org:admin" }),
        )
        .await;
    let app = seed_application(&harness, "Rollback role groups", "openid groups", "all").await;
    let grant = seed_grant(&harness, &app, &member, "role-rollback").await;
    fail_grant_updates(&harness).await;

    let demoted = harness
        .patch(
            &format!("/v1/organizations/{org}/memberships/{member}"),
            json!({ "role": "org:member" }),
        )
        .await;
    assert_eq!(demoted.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        membership_role(&harness, &org, &member).await,
        "org:admin",
        "the role change must roll back with the failed revocation"
    );
    assert!(!revoked(&harness, &grant).await);
}

#[tokio::test]
async fn organization_deletion_rolls_back_when_grant_revocation_fails() {
    let harness = setup().await;
    let owner = create_user(&harness).await;
    let member = create_user(&harness).await;
    let org = create_org(&harness, &owner, "Rollback delete").await;
    harness
        .post(
            &format!("/v1/organizations/{org}/memberships"),
            json!({ "user_id": member, "role": "org:member" }),
        )
        .await;
    let app = seed_application(&harness, "Rollback delete groups", "openid groups", "all").await;
    let grant = seed_grant(&harness, &app, &member, "delete-rollback").await;
    fail_grant_updates(&harness).await;

    let deleted = harness.delete(&format!("/v1/organizations/{org}")).await;
    assert_eq!(deleted.status, StatusCode::INTERNAL_SERVER_ERROR);
    let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM organizations WHERE id = $1")
        .bind(&org)
        .fetch_one(&harness.state().pool)
        .await
        .expect("organization");
    assert_eq!(exists, 1, "the organization must survive the rollback");
    assert_eq!(membership_role(&harness, &org, &member).await, "org:member");
    assert!(!revoked(&harness, &grant).await);
}

#[tokio::test]
async fn groups_claim_none_with_organizations_scope_is_revoked_on_every_change() {
    let harness = setup().await;
    let owner = create_user(&harness).await;
    let member = create_user(&harness).await;
    let org = create_org(&harness, &owner, "Org claims").await;
    harness
        .post(
            &format!("/v1/organizations/{org}/memberships"),
            json!({ "user_id": member, "role": "org:admin" }),
        )
        .await;
    // `groups_claim: none` only silences the `groups` claim; the organization
    // claims of the `organizations` scope are still asserted.
    let app = seed_application(
        &harness,
        "Org claims only",
        "openid offline_access organizations",
        "none",
    )
    .await;

    let demotion_grant = seed_grant(&harness, &app, &member, "none-demote").await;
    let demoted = harness
        .patch(
            &format!("/v1/organizations/{org}/memberships/{member}"),
            json!({ "role": "org:member" }),
        )
        .await;
    assert_eq!(demoted.status, StatusCode::OK, "{}", demoted.text());
    assert!(revoked(&harness, &demotion_grant).await);

    let removal_grant = seed_grant(&harness, &app, &member, "none-remove").await;
    let removed = harness
        .delete(&format!("/v1/organizations/{org}/memberships/{member}"))
        .await;
    assert_eq!(removed.status, StatusCode::OK, "{}", removed.text());
    assert!(revoked(&harness, &removal_grant).await);

    harness
        .post(
            &format!("/v1/organizations/{org}/memberships"),
            json!({ "user_id": member, "role": "org:member" }),
        )
        .await;
    let deletion_grant = seed_grant(&harness, &app, &member, "none-delete").await;
    let deleted = harness.delete(&format!("/v1/organizations/{org}")).await;
    assert_eq!(deleted.status, StatusCode::OK, "{}", deleted.text());
    assert!(revoked(&harness, &deletion_grant).await);
}

/// Seeds a live refresh grant that was issued with `scopes`.
async fn seed_grant_with_scopes(
    harness: &Harness,
    application_id: &str,
    user_id: &str,
    scopes: &str,
    label: &str,
) -> String {
    let id = seed_grant(harness, application_id, user_id, label).await;
    sqlx::query("UPDATE oauth_grants SET scopes = $1 WHERE id = $2")
        .bind(scopes)
        .bind(&id)
        .execute(&harness.state().pool)
        .await
        .expect("grant scopes");
    id
}

/// Revocation follows the scopes a grant was ISSUED with, not the
/// application's current configuration: an application edited after issuing
/// (dropping `organizations`, or switching `groups_claim` to `none`) must not
/// leave its already-issued authority-bearing grants live.
#[tokio::test]
async fn grants_issued_with_authority_scopes_are_revoked_after_the_application_changes() {
    let harness = setup().await;
    let owner = create_user(&harness).await;
    let member = create_user(&harness).await;
    let org = create_org(&harness, &owner, "Org edited apps").await;
    harness
        .post(
            &format!("/v1/organizations/{org}/memberships"),
            json!({ "user_id": member, "role": "org:admin" }),
        )
        .await;
    let app = seed_application(
        &harness,
        "Edited app",
        "openid offline_access organizations groups",
        "all",
    )
    .await;
    // The application is edited after the grants below were issued.
    let edit_application = |scopes: &'static str, groups_claim: &'static str| {
        let pool = harness.state().pool.clone();
        let app = app.clone();
        async move {
            sqlx::query(
                "UPDATE oauth_applications SET scopes = $1, groups_claim = $2 WHERE id = $3",
            )
            .bind(scopes)
            .bind(groups_claim)
            .bind(&app)
            .execute(&pool)
            .await
            .expect("edit application");
        }
    };

    for (label, issued_scopes, scopes_now, groups_now) in [
        (
            "dropped-organizations",
            "openid offline_access organizations",
            "openid offline_access",
            "all",
        ),
        (
            "groups-none",
            "openid offline_access groups",
            "openid offline_access groups",
            "none",
        ),
        (
            "comma-separated",
            "openid,offline_access,organizations",
            "openid",
            "none",
        ),
    ] {
        let grant = seed_grant_with_scopes(&harness, &app, &member, issued_scopes, label).await;
        edit_application(scopes_now, groups_now).await;
        let demoted = harness
            .patch(
                &format!("/v1/organizations/{org}/memberships/{member}"),
                json!({ "role": "org:member" }),
            )
            .await;
        assert_eq!(demoted.status, StatusCode::OK, "{}", demoted.text());
        assert!(revoked(&harness, &grant).await, "{label}: demotion");
        harness
            .patch(
                &format!("/v1/organizations/{org}/memberships/{member}"),
                json!({ "role": "org:admin" }),
            )
            .await;

        let grant = seed_grant_with_scopes(&harness, &app, &member, issued_scopes, label).await;
        let removed = harness
            .delete(&format!("/v1/organizations/{org}/memberships/{member}"))
            .await;
        assert_eq!(removed.status, StatusCode::OK, "{}", removed.text());
        assert!(revoked(&harness, &grant).await, "{label}: removal");
        harness
            .post(
                &format!("/v1/organizations/{org}/memberships"),
                json!({ "user_id": member, "role": "org:admin" }),
            )
            .await;
    }

    // Organization deletion.
    edit_application("openid offline_access", "none").await;
    let grant =
        seed_grant_with_scopes(&harness, &app, &member, "openid organizations", "delete").await;
    let plain = seed_grant_with_scopes(&harness, &app, &member, "openid profile", "plain").await;
    let deleted = harness.delete(&format!("/v1/organizations/{org}")).await;
    assert_eq!(deleted.status, StatusCode::OK, "{}", deleted.text());
    assert!(revoked(&harness, &grant).await, "organization deletion");
    assert!(!revoked(&harness, &plain).await, "scope-less grant kept");
}
