//! Flow-level ports of `test/security/enterprise-additional-identifications.test.ts`
//! and the connect half of `services/external-identity.ts`. These drive the
//! public state machine directly, as the TS tests do.

mod common;

use axum::http::StatusCode;
use common::{harness, seed_user, Harness};
use orbitid_core::models::ExternalAccountRow;
use orbitid_fapi_auth::external::{handle_external_identity, ExternalIdentityFlow};
use orbitid_identity::external_identity::ExternalProfile;
use orbitid_platform::mail::{latest_code_for, EmailTemplate};

async fn client_id(h: &Harness) -> String {
    h.client.get("/v1/client", &[]).await.value()["response"]["id"]
        .as_str()
        .unwrap()
        .to_string()
}

async fn link_connection(h: &Harness, id: &str, user_id: &str, email: &str, restricted: bool) {
    let now = orbitid_core::http::now();
    sqlx::query(
        "INSERT INTO enterprise_connections (id, name, protocol, provider, domains, active, \
         allow_subdomains, allow_idp_initiated, sync_user_attributes, \
         disable_additional_identifications, config, created_at, updated_at) \
         VALUES ($1, $1, 'oidc', 'custom', '[]'::jsonb, true, false, false, true, $2, \
         '{}'::jsonb, $3, $3)",
    )
    .bind(id)
    .bind(restricted)
    .bind(now)
    .execute(&h.state().pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO external_accounts (id, user_id, provider, provider_user_id, email_address, \
         first_name, last_name, approved_scopes, public_metadata, created_at, updated_at) \
         VALUES ($1, $2, $3, $4, $5, 'Test', 'User', '', '{}'::jsonb, $6, $6)",
    )
    .bind(format!("eac_{id}"))
    .bind(user_id)
    .bind(format!("oidc_{id}"))
    .bind(format!("subject_{id}"))
    .bind(email)
    .bind(now)
    .execute(&h.state().pool)
    .await
    .unwrap();
}

fn flow(client_id: &str, kind: &str) -> ExternalIdentityFlow {
    ExternalIdentityFlow {
        client_id: client_id.to_string(),
        kind: kind.to_string(),
        owner_id: None,
        user_id: None,
        redirect_url: "http://localhost:3000/done".into(),
        action_complete_redirect_url: None,
        trusted_device_token: None,
    }
}

fn profile(provider: &str, subject: &str, email: &str) -> ExternalProfile {
    ExternalProfile {
        provider: provider.into(),
        provider_user_id: subject.into(),
        email: Some(email.into()),
        email_verified: Some(true),
        first_name: Some("Ada".into()),
        last_name: Some("Lovelace".into()),
        ..Default::default()
    }
}

async fn external_accounts(h: &Harness, provider: &str) -> Vec<ExternalAccountRow> {
    sqlx::query_as::<_, ExternalAccountRow>("SELECT * FROM external_accounts WHERE provider = $1")
        .bind(provider)
        .fetch_all(&h.state().pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn a_restricted_connection_refuses_auto_linking_during_sign_in() {
    let h = harness().await;
    let user = seed_user(&h, "signin@example.com", "Sup3r-secret!").await;
    link_connection(&h, "ent_restricted", &user.user.id, &user.email, true).await;
    let client = client_id(&h).await;

    let result = handle_external_identity(
        h.state(),
        &flow(&client, "sign_in"),
        &profile("google", "g-auto", &user.email),
    )
    .await
    .unwrap();
    assert!(
        result
            .redirect_to
            .contains("__orbit_error=not_allowed_access"),
        "{}",
        result.redirect_to
    );
    assert!(external_accounts(&h, "google").await.is_empty());
    let client_state = h.client.get("/v1/client", &[]).await.value();
    assert!(client_state["response"]["sessions"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn a_restricted_connection_refuses_auto_linking_during_sign_up() {
    let h = harness().await;
    let user = seed_user(&h, "signup@example.com", "Sup3r-secret!").await;
    link_connection(&h, "ent_restricted", &user.user.id, &user.email, true).await;
    let created = h
        .client
        .post(
            "/v1/client/sign_ups",
            Some(serde_json::json!({ "email_address": "new@example.com" })),
            &[],
        )
        .await;
    let sign_up_id = created.value()["response"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let mut sign_up_flow = flow(&client_id(&h).await, "sign_up");
    sign_up_flow.owner_id = Some(sign_up_id);
    let result = handle_external_identity(
        h.state(),
        &sign_up_flow,
        &profile("github", "gh-auto", &user.email),
    )
    .await
    .unwrap();
    assert!(
        result
            .redirect_to
            .contains("__orbit_error=not_allowed_access"),
        "{}",
        result.redirect_to
    );
    assert!(external_accounts(&h, "github").await.is_empty());
}

#[tokio::test]
async fn a_restricted_connection_refuses_to_create_a_password_through_recovery() {
    let h = harness().await;
    let user = seed_user(&h, "recovery-ent@example.com", "Sup3r-secret!").await;
    link_connection(&h, "ent_restricted", &user.user.id, &user.email, true).await;

    let created = h
        .client
        .post(
            "/v1/client/sign_ins",
            Some(serde_json::json!({
                "identifier": "recovery-ent@example.com",
                "strategy": "reset_password_email_code",
            })),
            &[],
        )
        .await;
    let id = created.value()["response"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    h.client
        .post(
            &format!("/v1/client/sign_ins/{id}/prepare_first_factor"),
            Some(serde_json::json!({ "strategy": "reset_password_email_code" })),
            &[],
        )
        .await;
    let code = latest_code_for(
        &h.app.app_state(),
        "recovery-ent@example.com",
        Some(EmailTemplate::ResetPasswordCode),
    )
    .expect("reset code");
    h.client
        .post(
            &format!("/v1/client/sign_ins/{id}/attempt_first_factor"),
            Some(serde_json::json!({
                "strategy": "reset_password_email_code",
                "code": code,
            })),
            &[],
        )
        .await;

    let reset = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{id}/reset_password"),
            Some(serde_json::json!({
                "password": "N3wSup3rSecret!",
                "sign_out_of_other_sessions": false,
            })),
            &[],
        )
        .await;
    assert_eq!(reset.status, StatusCode::FORBIDDEN);
    assert_eq!(reset.error_codes(), vec!["not_allowed_access"]);
}

#[tokio::test]
async fn connecting_an_external_account_upgrades_a_guest() {
    let h = harness().await;
    let guest = orbitid_identity::testing::create_test_guest(h.state())
        .await
        .unwrap();
    assert!(guest.is_anonymous);
    let mut connect = flow(&client_id(&h).await, "connect");
    connect.user_id = Some(guest.id.clone());
    let result = handle_external_identity(
        h.state(),
        &connect,
        &profile("github", "gh-guest", "guest@example.com"),
    )
    .await
    .unwrap();
    assert!(
        result.redirect_to.contains("__orbit_status=connected"),
        "{}",
        result.redirect_to
    );
    assert!(result.redirect_to.contains("external_account_id="));
    let refreshed = orbitid_identity::users::get_user_by_id(h.state(), &guest.id)
        .await
        .unwrap()
        .unwrap();
    assert!(!refreshed.is_anonymous);
    let linked = external_accounts(&h, "github").await;
    assert_eq!(linked.len(), 1);
    assert_eq!(linked[0].user_id.as_deref(), Some(guest.id.as_str()));
}

#[tokio::test]
async fn connecting_an_account_owned_by_another_user_is_refused() {
    let h = harness().await;
    let owner = seed_user(&h, "owner@example.com", "Sup3r-secret!").await;
    let other = seed_user(&h, "other@example.com", "Sup3r-secret!").await;
    let linked = orbitid_identity::external_identity::link_external_account(
        h.state(),
        &owner.user.id,
        &profile("github", "gh-owner", &owner.email),
    )
    .await
    .unwrap();
    assert_eq!(linked.user_id.as_deref(), Some(owner.user.id.as_str()));

    let mut connect = flow(&client_id(&h).await, "connect");
    connect.user_id = Some(other.user.id.clone());
    let result = handle_external_identity(
        h.state(),
        &connect,
        &profile("github", "gh-owner", &owner.email),
    )
    .await
    .unwrap();
    assert!(
        result
            .redirect_to
            .contains("__orbit_error=external_account_exists"),
        "{}",
        result.redirect_to
    );
    let linked = external_accounts(&h, "github").await;
    assert_eq!(linked.len(), 1);
    assert_eq!(linked[0].user_id.as_deref(), Some(owner.user.id.as_str()));
}
