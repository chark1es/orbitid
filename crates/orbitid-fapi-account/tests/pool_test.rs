//! Single-connection (`max_connections = 1`) coverage for every converted
//! transaction in this crate: a handler that takes a second pool connection
//! while its transaction is open would time out here.

use axum::http::StatusCode;
use axum::Router;
use orbitid_core::config::EnvOverrides;
use orbitid_core::http::{csrf_protection, security_headers, upload_size_limit};
use orbitid_core::testing::{TestClient, TestResponse};
use orbitid_core::AppState;
use orbitid_credentials::mfa::totp_code_at;
use orbitid_credentials::{
    CreationOptionsJson, CredentialOverrides, VirtualAlgorithm, VirtualAuthenticator,
    VirtualAuthenticatorOptions,
};
use orbitid_identity::testing::{sign_up_user, test_app_state_with};
use serde_json::{json, Value};

const APP_ORIGIN: &str = "http://localhost:3000";
const APP_RP_ID: &str = "localhost";

fn build(state: AppState) -> Router {
    orbitid_fapi_account::router()
        .with_state(state.clone())
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            csrf_protection,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            upload_size_limit,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state,
            security_headers,
        ))
}

fn expect_ok(response: TestResponse, what: &str) -> Value {
    assert_eq!(
        response.status,
        StatusCode::OK,
        "{what}: {}",
        response.text()
    );
    response.value()
}

#[tokio::test]
async fn every_account_flow_works_on_a_single_connection_pool() {
    let app = test_app_state_with(EnvOverrides {
        db_max_connections: Some(1),
        db_acquire_timeout_ms: Some(2_000),
        ..Default::default()
    })
    .await;
    app.state()
        .settings
        .update(json!({
            "organizations": { "enabled": true },
            "attributes": { "passkey": { "enabled": true, "usedForFirstFactor": true } }
        }))
        .await
        .expect("settings");
    let router = build(app.state().clone());
    let signed = sign_up_user(app.state(), "pool@example.com", "Sup3r-secret!")
        .await
        .expect("fixture");
    let user_id = signed.user.user.id.clone();
    let browser = TestClient::with_cookie(router.clone(), &signed.auth.cookie);

    // Profile update.
    expect_ok(
        browser
            .request(
                "PATCH",
                "/v1/client/me",
                Some(json!({ "first_name": "Pool", "last_name": "One" })),
                &[],
            )
            .await,
        "profile update",
    );

    // Add + verify an email address.
    let added = expect_ok(
        browser
            .post(
                "/v1/client/me/email_addresses",
                Some(json!({ "email_address": "pool-second@example.com" })),
                &[],
            )
            .await,
        "add email",
    );
    let email_id = added["response"]["id"]
        .as_str()
        .expect("email id")
        .to_string();
    expect_ok(
        browser
            .post(
                &format!("/v1/client/me/email_addresses/{email_id}/prepare_verification"),
                Some(json!({})),
                &[],
            )
            .await,
        "prepare email",
    );
    let code =
        orbitid_platform::mail::latest_code_for(app.state(), "pool-second@example.com", None)
            .expect("code");
    expect_ok(
        browser
            .post(
                &format!("/v1/client/me/email_addresses/{email_id}/attempt_verification"),
                Some(json!({ "code": code })),
                &[],
            )
            .await,
        "verify email",
    );

    // Change the password.
    expect_ok(
        browser
            .post(
                "/v1/client/me/change_password",
                Some(json!({
                    "current_password": "Sup3r-secret!",
                    "new_password": "N3w-Sup3r-secret!",
                })),
                &[],
            )
            .await,
        "change password",
    );

    // Enable and then disable TOTP.
    let setup = expect_ok(
        browser
            .post("/v1/client/me/totp", Some(json!({})), &[])
            .await,
        "start totp",
    );
    let secret = setup["response"]["secret"]
        .as_str()
        .expect("secret")
        .to_string();
    let totp = totp_code_at(&secret, orbitid_core::http::now() / 1000).expect("totp");
    expect_ok(
        browser
            .post(
                "/v1/client/me/totp/attempt_verification",
                Some(json!({ "code": totp })),
                &[],
            )
            .await,
        "confirm totp",
    );
    expect_ok(
        browser.delete("/v1/client/me/totp", None, &[]).await,
        "disable totp",
    );

    // Register a passkey with the virtual authenticator.
    let begin = expect_ok(
        browser
            .post(
                "/v1/client/me/passkeys",
                Some(json!({ "authenticator_type": "platform" })),
                &[("origin", APP_ORIGIN)],
            )
            .await,
        "begin passkey",
    );
    let passkey_id = begin["response"]["id"]
        .as_str()
        .expect("passkey id")
        .to_string();
    let options: CreationOptionsJson =
        serde_json::from_value(begin["response"]["public_key_credential_creation_options"].clone())
            .expect("options");
    let mut options_impl = VirtualAuthenticatorOptions::new(APP_RP_ID, APP_ORIGIN);
    options_impl.alg = VirtualAlgorithm::Es256;
    let mut authenticator = VirtualAuthenticator::new(options_impl).expect("authenticator");
    let credential = authenticator.register(&options, CredentialOverrides::default());
    expect_ok(
        browser
            .post(
                &format!("/v1/client/me/passkeys/{passkey_id}/attempt_verification"),
                Some(json!({ "public_key_credential": credential })),
                &[("origin", APP_ORIGIN)],
            )
            .await,
        "finish passkey",
    );

    // Create an organization.
    let org = expect_ok(
        browser
            .post(
                "/v1/client/organizations",
                Some(json!({ "name": "Pool Org" })),
                &[],
            )
            .await,
        "create org",
    );
    let org_id = org["response"]["id"].as_str().expect("org id").to_string();
    expect_ok(
        browser
            .post(
                &format!("/v1/client/organizations/{org_id}/invitations"),
                Some(json!({ "email_address": "pool-invitee@example.com" })),
                &[],
            )
            .await,
        "invite",
    );

    // A second member leaves (last-admin lock path).
    let member = sign_up_user(app.state(), "pool-member@example.com", "Sup3r-secret!")
        .await
        .expect("member fixture");
    sqlx::query(
        "INSERT INTO organization_memberships (id, organization_id, user_id, role_key, \
         public_metadata, private_metadata, created_at, updated_at) \
         VALUES ('mem_pool_member', $1, $2, 'org:member', '{}', '{}', 1, 1)",
    )
    .bind(&org_id)
    .bind(&member.user.user.id)
    .execute(&app.state().pool)
    .await
    .expect("membership");
    let member_browser = TestClient::with_cookie(router.clone(), &member.auth.cookie);
    expect_ok(
        member_browser
            .delete(
                &format!("/v1/client/me/organization_memberships/{org_id}"),
                None,
                &[],
            )
            .await,
        "leave org",
    );

    // Delete the account (deletes the organization it still administers).
    expect_ok(
        browser.delete("/v1/client/me", None, &[]).await,
        "delete account",
    );
    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE id = $1")
        .bind(&user_id)
        .fetch_one(&app.state().pool)
        .await
        .expect("user");
    assert_eq!(remaining, 0);
}
