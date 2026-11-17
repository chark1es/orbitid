//! Rollback tests for mutations whose writes and webhook events must commit
//! together. Each test makes the event insert fail after the main writes.

mod common;

use axum::http::StatusCode;
use common::*;
use orbitid_core::AppState;
use orbitid_credentials::mfa::totp_code_at;
use serde_json::json;

async fn fail_webhook_events(state: &AppState) {
    sqlx::query(
        "CREATE OR REPLACE FUNCTION orbitid_test_fail_event() RETURNS trigger AS $$ \
         BEGIN RAISE EXCEPTION 'injected event failure'; END; $$ LANGUAGE plpgsql",
    )
    .execute(&state.pool)
    .await
    .expect("function");
    sqlx::query(
        "CREATE TRIGGER orbitid_test_fail_event BEFORE INSERT ON webhook_events \
         FOR EACH ROW EXECUTE FUNCTION orbitid_test_fail_event()",
    )
    .execute(&state.pool)
    .await
    .expect("trigger");
}

#[tokio::test]
async fn password_change_rolls_back_when_its_event_cannot_be_written() {
    let harness = harness().await;
    let signed = harness
        .signed_in("atomic-password@example.com", "Sup3r-secret!")
        .await;
    let before: Option<String> =
        sqlx::query_scalar("SELECT password_hash FROM users WHERE id = $1")
            .bind(&signed.user_id)
            .fetch_one(&harness.state().pool)
            .await
            .expect("hash");
    fail_webhook_events(harness.state()).await;

    let response = signed
        .client
        .post(
            "/v1/client/me/change_password",
            Some(json!({
                "current_password": "Sup3r-secret!",
                "new_password": "N3w-Sup3r-secret!",
                "sign_out_of_other_sessions": true,
            })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    let after: Option<String> = sqlx::query_scalar("SELECT password_hash FROM users WHERE id = $1")
        .bind(&signed.user_id)
        .fetch_one(&harness.state().pool)
        .await
        .expect("hash");
    assert_eq!(
        after, before,
        "the old password must survive a rolled-back change"
    );
}

#[tokio::test]
async fn email_verification_rolls_back_when_its_event_cannot_be_written() {
    let harness = harness().await;
    let signed = harness
        .signed_in("atomic-email@example.com", "Sup3r-secret!")
        .await;
    let added = signed
        .client
        .post(
            "/v1/client/me/email_addresses",
            Some(json!({ "email_address": "second@example.com" })),
            &[],
        )
        .await;
    assert_eq!(added.status, StatusCode::OK, "{}", added.text());
    let id = added.value()["response"]["id"]
        .as_str()
        .expect("email id")
        .to_string();
    let prepared = signed
        .client
        .post(
            &format!("/v1/client/me/email_addresses/{id}/prepare_verification"),
            Some(json!({})),
            &[],
        )
        .await;
    assert_eq!(prepared.status, StatusCode::OK, "{}", prepared.text());
    let code = orbitid_platform::mail::latest_code_for(harness.state(), "second@example.com", None)
        .expect("code");
    fail_webhook_events(harness.state()).await;

    let attempted = signed
        .client
        .post(
            &format!("/v1/client/me/email_addresses/{id}/attempt_verification"),
            Some(json!({ "code": code })),
            &[],
        )
        .await;
    assert_eq!(attempted.status, StatusCode::INTERNAL_SERVER_ERROR);
    let verified: bool = sqlx::query_scalar("SELECT verified FROM email_addresses WHERE id = $1")
        .bind(&id)
        .fetch_one(&harness.state().pool)
        .await
        .expect("email");
    assert!(!verified, "the address must stay unverified");
}

#[tokio::test]
async fn mfa_disable_rolls_back_when_its_event_cannot_be_written() {
    let harness = harness().await;
    let signed = harness
        .signed_in("atomic-mfa@example.com", "Sup3r-secret!")
        .await;
    let setup = signed
        .client
        .post("/v1/client/me/totp", Some(json!({})), &[])
        .await;
    assert_eq!(setup.status, StatusCode::OK, "{}", setup.text());
    let secret = setup.value()["response"]["secret"]
        .as_str()
        .expect("secret")
        .to_string();
    let code = totp_code_at(&secret, orbitid_core::http::now() / 1000).expect("code");
    let verified = signed
        .client
        .post(
            "/v1/client/me/totp/attempt_verification",
            Some(json!({ "code": code })),
            &[],
        )
        .await;
    assert_eq!(verified.status, StatusCode::OK, "{}", verified.text());
    fail_webhook_events(harness.state()).await;

    let disabled = signed.client.delete("/v1/client/me/totp", None, &[]).await;
    assert_eq!(disabled.status, StatusCode::INTERNAL_SERVER_ERROR);
    let enabled: bool = sqlx::query_scalar("SELECT totp_verified FROM users WHERE id = $1")
        .bind(&signed.user_id)
        .fetch_one(&harness.state().pool)
        .await
        .expect("user");
    assert!(
        enabled,
        "TOTP must stay enabled after a rolled-back disable"
    );
}

#[tokio::test]
async fn account_deletion_rolls_back_when_its_event_cannot_be_written() {
    let harness = harness().await;
    let signed = harness
        .signed_in("atomic-delete@example.com", "Sup3r-secret!")
        .await;
    fail_webhook_events(harness.state()).await;

    let deleted = signed.client.delete("/v1/client/me", None, &[]).await;
    assert_eq!(deleted.status, StatusCode::INTERNAL_SERVER_ERROR);
    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE id = $1")
        .bind(&signed.user_id)
        .fetch_one(&harness.state().pool)
        .await
        .expect("count");
    assert_eq!(remaining, 1, "the user must survive a rolled-back deletion");
}

/// Enables organizations with the features the organization tests need.
async fn enable_organizations(state: &AppState) {
    state
        .settings
        .update(json!({
            "organizations": {
                "enabled": true,
                "domainsEnabled": true,
                "adminDeleteEnabled": true
            }
        }))
        .await
        .expect("settings");
}

#[tokio::test]
async fn profile_update_rolls_back_when_its_event_cannot_be_written() {
    let harness = harness().await;
    let signed = harness
        .signed_in("atomic-profile@example.com", "Sup3r-secret!")
        .await;
    fail_webhook_events(harness.state()).await;
    let response = signed
        .client
        .request(
            "PATCH",
            "/v1/client/me",
            Some(json!({ "first_name": "Ada" })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    let first_name: Option<String> =
        sqlx::query_scalar("SELECT first_name FROM users WHERE id = $1")
            .bind(&signed.user_id)
            .fetch_one(&harness.state().pool)
            .await
            .expect("user");
    assert_eq!(
        first_name, None,
        "the profile update must roll back with its event"
    );
}

#[tokio::test]
async fn avatar_upload_rolls_back_when_its_event_cannot_be_written() {
    let harness = harness().await;
    let signed = harness
        .signed_in("atomic-avatar@example.com", "Sup3r-secret!")
        .await;
    let uploads_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM uploads")
        .fetch_one(&harness.state().pool)
        .await
        .expect("uploads");
    fail_webhook_events(harness.state()).await;
    let response = signed
        .client
        .post(
            "/v1/client/me/profile_image",
            Some(json!({ "file": data_url("image/png", PNG_1X1) })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    let uploads_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM uploads")
        .fetch_one(&harness.state().pool)
        .await
        .expect("uploads");
    assert_eq!(
        uploads_after, uploads_before,
        "the upload row must roll back"
    );
    let has_image: bool = sqlx::query_scalar("SELECT has_image FROM users WHERE id = $1")
        .bind(&signed.user_id)
        .fetch_one(&harness.state().pool)
        .await
        .expect("user");
    assert!(!has_image, "the avatar pointer must not commit");
}

#[tokio::test]
async fn totp_enrollment_rolls_back_when_its_event_cannot_be_written() {
    let harness = harness().await;
    let signed = harness
        .signed_in("atomic-totp@example.com", "Sup3r-secret!")
        .await;
    let setup = signed
        .client
        .post("/v1/client/me/totp", Some(json!({})), &[])
        .await;
    assert_eq!(setup.status, StatusCode::OK, "{}", setup.text());
    let secret = setup.value()["response"]["secret"]
        .as_str()
        .expect("secret")
        .to_string();
    let code = totp_code_at(&secret, orbitid_core::http::now() / 1000).expect("code");
    fail_webhook_events(harness.state()).await;
    let response = signed
        .client
        .post(
            "/v1/client/me/totp/attempt_verification",
            Some(json!({ "code": code })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    let (verified, codes): (bool, Option<sqlx::types::Json<Vec<String>>>) =
        sqlx::query_as("SELECT totp_verified, backup_codes FROM users WHERE id = $1")
            .bind(&signed.user_id)
            .fetch_one(&harness.state().pool)
            .await
            .expect("user");
    assert!(!verified, "TOTP must stay pending after a rollback");
    assert!(codes.map(|codes| codes.0.is_empty()).unwrap_or(true));
}

#[tokio::test]
async fn passkey_delete_rolls_back_when_its_event_cannot_be_written() {
    let harness = harness().await;
    let signed = harness
        .signed_in("atomic-passkey@example.com", "Sup3r-secret!")
        .await;
    sqlx::query(
        "INSERT INTO passkeys (id, user_id, name, credential_id, public_key, counter, \
         device_type, backed_up, created_at, updated_at) \
         VALUES ('pkey_atomic', $1, 'Key', 'cred_atomic', 'pk', 0, 'singleDevice', false, 1, 1)",
    )
    .bind(&signed.user_id)
    .execute(&harness.state().pool)
    .await
    .expect("passkey");
    fail_webhook_events(harness.state()).await;
    let response = signed
        .client
        .delete("/v1/client/me/passkeys/pkey_atomic", None, &[])
        .await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    let remaining: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM passkeys WHERE id = 'pkey_atomic'")
            .fetch_one(&harness.state().pool)
            .await
            .expect("passkeys");
    assert_eq!(
        remaining, 1,
        "the credential must survive a rolled-back delete"
    );
}

#[tokio::test]
async fn organization_invitation_create_rolls_back_when_its_event_cannot_be_written() {
    let harness = harness().await;
    enable_organizations(harness.state()).await;
    let signed = harness
        .signed_in("atomic-invite@example.com", "Sup3r-secret!")
        .await;
    let org = signed
        .client
        .post(
            "/v1/client/organizations",
            Some(json!({ "name": "Atomic Org" })),
            &[],
        )
        .await;
    assert_eq!(org.status, StatusCode::OK, "{}", org.text());
    let org_id = org.value()["response"]["id"]
        .as_str()
        .expect("org id")
        .to_string();
    fail_webhook_events(harness.state()).await;
    let response = signed
        .client
        .post(
            &format!("/v1/client/organizations/{org_id}/invitations"),
            Some(json!({ "email_address": "invitee@example.com" })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    let invitations: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM organization_invitations WHERE organization_id = $1",
    )
    .bind(&org_id)
    .fetch_one(&harness.state().pool)
    .await
    .expect("invitations");
    assert_eq!(
        invitations, 0,
        "the invitation must roll back with its event"
    );
}

#[tokio::test]
async fn domain_create_rolls_back_when_its_event_cannot_be_written() {
    let harness = harness().await;
    enable_organizations(harness.state()).await;
    let signed = harness
        .signed_in("atomic-domain@example.com", "Sup3r-secret!")
        .await;
    let org = signed
        .client
        .post(
            "/v1/client/organizations",
            Some(json!({ "name": "Domain Org" })),
            &[],
        )
        .await;
    let org_id = org.value()["response"]["id"]
        .as_str()
        .expect("org id")
        .to_string();
    fail_webhook_events(harness.state()).await;
    let response = signed
        .client
        .post(
            &format!("/v1/client/organizations/{org_id}/domains"),
            Some(json!({ "name": "atomic.test" })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    let domains: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM organization_domains WHERE organization_id = $1")
            .bind(&org_id)
            .fetch_one(&harness.state().pool)
            .await
            .expect("domains");
    assert_eq!(domains, 0, "the domain must roll back with its event");
}

#[tokio::test]
async fn waiting_list_join_rolls_back_when_its_event_cannot_be_written() {
    let harness = harness().await;
    harness
        .state()
        .settings
        .update(json!({ "signUp": { "mode": "waitlist" } }))
        .await
        .expect("settings");
    fail_webhook_events(harness.state()).await;
    let browser = harness.client();
    let response = browser
        .post(
            "/v1/client/waitlist",
            Some(json!({ "email_address": "atomic-wait@example.com" })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    let entries: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM waitlist_entries WHERE email = 'atomic-wait@example.com'",
    )
    .fetch_one(&harness.state().pool)
    .await
    .expect("waitlist");
    assert_eq!(entries, 0, "the entry must roll back with its event");
}

async fn create_organization(owner: &SignedIn, name: &str) -> String {
    let response = owner
        .client
        .post(
            "/v1/client/organizations",
            Some(json!({ "name": name })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    response.value()["response"]["id"]
        .as_str()
        .expect("organization id")
        .to_string()
}

async fn seed_authority_grant(harness: &Harness, user_id: &str) -> String {
    let application_id = orbitid_core::ids::new_id("oa");
    let now = orbitid_core::http::now();
    sqlx::query(
        "INSERT INTO oauth_applications (id, name, client_id, redirect_uris, scopes, \
         groups_claim, created_at, updated_at) VALUES ($1,'Atomic groups',$2,'[]','openid groups','all',$3,$3)",
    )
    .bind(&application_id)
    .bind(format!("client-{application_id}"))
    .bind(now)
    .execute(&harness.state().pool)
    .await
    .expect("application");
    let grant_id = orbitid_core::ids::new_id("oag");
    sqlx::query(
        "INSERT INTO oauth_grants (id, kind, application_id, user_id, token_hash, scopes, \
         family_id, revoked, expires_at, created_at) \
         VALUES ($1,'refresh',$2,$3,$4,'openid',$5,false,$6,$7)",
    )
    .bind(&grant_id)
    .bind(&application_id)
    .bind(user_id)
    .bind(format!("hash_{grant_id}"))
    .bind(format!("family_{grant_id}"))
    .bind(now + 3_600_000)
    .bind(now)
    .execute(&harness.state().pool)
    .await
    .expect("grant");
    grant_id
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

async fn grant_revoked(harness: &Harness, grant_id: &str) -> bool {
    sqlx::query_scalar("SELECT revoked FROM oauth_grants WHERE id = $1")
        .bind(grant_id)
        .fetch_one(&harness.state().pool)
        .await
        .expect("grant")
}

async fn member_role(harness: &Harness, org_id: &str, user_id: &str) -> String {
    sqlx::query_scalar(
        "SELECT role_key FROM organization_memberships WHERE organization_id = $1 AND user_id = $2",
    )
    .bind(org_id)
    .bind(user_id)
    .fetch_one(&harness.state().pool)
    .await
    .expect("membership")
}

#[tokio::test]
async fn organization_role_change_rolls_back_when_grant_revocation_fails() {
    let harness = harness().await;
    enable_organizations(harness.state()).await;
    let owner = harness
        .signed_in("atomic-org-role-owner@example.com", "Sup3r-secret!")
        .await;
    let member = harness
        .signed_in("atomic-org-role-member@example.com", "Sup3r-secret!")
        .await;
    let org_id = create_organization(&owner, "Atomic role").await;
    orbitid_identity::testing::add_test_member(
        harness.state(),
        &org_id,
        &member.user_id,
        "org:member",
    )
    .await
    .expect("member");
    let grant = seed_authority_grant(&harness, &member.user_id).await;
    fail_grant_updates(&harness).await;

    let changed = owner
        .client
        .request(
            "PATCH",
            &format!(
                "/v1/client/organizations/{org_id}/memberships/{}",
                member.user_id
            ),
            Some(json!({ "role": "org:admin" })),
            &[],
        )
        .await;
    assert_eq!(changed.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        member_role(&harness, &org_id, &member.user_id).await,
        "org:member",
        "the role change must roll back with the failed revocation"
    );
    assert!(!grant_revoked(&harness, &grant).await);
}

#[tokio::test]
async fn organization_member_removal_rolls_back_when_grant_revocation_fails() {
    let harness = harness().await;
    enable_organizations(harness.state()).await;
    let owner = harness
        .signed_in("atomic-org-remove-owner@example.com", "Sup3r-secret!")
        .await;
    let member = harness
        .signed_in("atomic-org-remove-member@example.com", "Sup3r-secret!")
        .await;
    let org_id = create_organization(&owner, "Atomic remove").await;
    orbitid_identity::testing::add_test_member(
        harness.state(),
        &org_id,
        &member.user_id,
        "org:member",
    )
    .await
    .expect("member");
    let grant = seed_authority_grant(&harness, &member.user_id).await;
    fail_grant_updates(&harness).await;

    let removed = owner
        .client
        .request(
            "DELETE",
            &format!(
                "/v1/client/organizations/{org_id}/memberships/{}",
                member.user_id
            ),
            None,
            &[],
        )
        .await;
    assert_eq!(removed.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        member_role(&harness, &org_id, &member.user_id).await,
        "org:member",
        "the membership must survive the rollback"
    );
    assert!(!grant_revoked(&harness, &grant).await);
}

#[tokio::test]
async fn organization_leave_rolls_back_when_grant_revocation_fails() {
    let harness = harness().await;
    enable_organizations(harness.state()).await;
    let owner = harness
        .signed_in("atomic-org-leave-owner@example.com", "Sup3r-secret!")
        .await;
    let member = harness
        .signed_in("atomic-org-leave-member@example.com", "Sup3r-secret!")
        .await;
    let org_id = create_organization(&owner, "Atomic leave").await;
    orbitid_identity::testing::add_test_member(
        harness.state(),
        &org_id,
        &member.user_id,
        "org:member",
    )
    .await
    .expect("member");
    let grant = seed_authority_grant(&harness, &member.user_id).await;
    fail_grant_updates(&harness).await;

    let left = member
        .client
        .request(
            "DELETE",
            &format!("/v1/client/me/organization_memberships/{org_id}"),
            None,
            &[],
        )
        .await;
    assert_eq!(left.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        member_role(&harness, &org_id, &member.user_id).await,
        "org:member",
        "the membership must survive the rollback"
    );
    assert!(!grant_revoked(&harness, &grant).await);
}

#[tokio::test]
async fn organization_deletion_rolls_back_when_grant_revocation_fails() {
    let harness = harness().await;
    enable_organizations(harness.state()).await;
    let owner = harness
        .signed_in("atomic-org-delete-owner@example.com", "Sup3r-secret!")
        .await;
    let member = harness
        .signed_in("atomic-org-delete-member@example.com", "Sup3r-secret!")
        .await;
    let org_id = create_organization(&owner, "Atomic delete").await;
    orbitid_identity::testing::add_test_member(
        harness.state(),
        &org_id,
        &member.user_id,
        "org:member",
    )
    .await
    .expect("member");
    let grant = seed_authority_grant(&harness, &member.user_id).await;
    fail_grant_updates(&harness).await;

    let deleted = owner
        .client
        .request(
            "DELETE",
            &format!("/v1/client/organizations/{org_id}"),
            None,
            &[],
        )
        .await;
    assert_eq!(deleted.status, StatusCode::INTERNAL_SERVER_ERROR);
    let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM organizations WHERE id = $1")
        .bind(&org_id)
        .fetch_one(&harness.state().pool)
        .await
        .expect("organization");
    assert_eq!(exists, 1, "the organization must survive the rollback");
    assert!(!grant_revoked(&harness, &grant).await);
}
