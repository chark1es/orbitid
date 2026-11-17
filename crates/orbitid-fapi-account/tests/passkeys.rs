//! Passkey registration HTTP tests (`test/passkeys-register.test.ts`,
//! `test/passkeys-negative.test.ts` registration half, `test/passkeys-flows.test.ts`
//! relying-party cases). Sign-in ceremonies belong to `orbitid-fapi-auth`.

mod common;

use axum::http::StatusCode;
use common::*;
use orbitid_core::testing::TestClient;
use orbitid_credentials::{
    CreationOptionsJson, CredentialOverrides, VirtualAlgorithm, VirtualAuthenticator,
    VirtualAuthenticatorOptions,
};
use serde_json::{json, Value};

const APP_ORIGIN: &str = "http://localhost:3000";
const APP_RP_ID: &str = "localhost";

async fn enable_passkeys(h: &Harness) {
    h.state()
        .settings
        .update(
            json!({ "attributes": { "passkey": { "enabled": true, "usedForFirstFactor": true } } }),
        )
        .await
        .expect("settings");
}

fn new_authenticator(alg: VirtualAlgorithm) -> VirtualAuthenticator {
    let mut options = VirtualAuthenticatorOptions::new(APP_RP_ID, APP_ORIGIN);
    options.alg = alg;
    VirtualAuthenticator::new(options).expect("authenticator")
}

async fn begin(client: &TestClient, body: Value) -> Value {
    let response = client
        .request(
            "POST",
            "/v1/client/me/passkeys",
            Some(body),
            &[("origin", APP_ORIGIN)],
        )
        .await;
    assert_status(&response, StatusCode::OK);
    response.value()["response"].clone()
}

async fn finish(
    client: &TestClient,
    id: &str,
    credential: Value,
    origin: &str,
) -> orbitid_core::testing::TestResponse {
    client
        .request(
            "POST",
            &format!("/v1/client/me/passkeys/{id}/attempt_verification"),
            Some(json!({ "public_key_credential": credential })),
            &[("origin", origin)],
        )
        .await
}

fn creation_options(begin_response: &Value) -> CreationOptionsJson {
    serde_json::from_value(begin_response["public_key_credential_creation_options"].clone())
        .expect("creation options")
}

async fn register(
    client: &TestClient,
    mut authenticator: VirtualAuthenticator,
    name: Option<&str>,
    body: Value,
) -> (Value, VirtualAuthenticator) {
    let begin_response = begin(client, body).await;
    let id = begin_response["id"].as_str().expect("id").to_string();
    let credential = authenticator.register(
        &creation_options(&begin_response),
        CredentialOverrides::default(),
    );
    let serialized = serde_json::to_value(&credential).expect("credential json");
    let finished = finish(client, &id, serialized, APP_ORIGIN).await;
    assert_status(&finished, StatusCode::OK);
    if let Some(name) = name {
        assert_eq!(finished.value()["response"]["name"], name);
    }
    (finished.value()["response"].clone(), authenticator)
}

#[tokio::test]
async fn registers_an_es256_passkey_with_counter_transports_and_backup_flags() {
    let h = harness().await;
    enable_passkeys(&h).await;
    let user = h
        .signed_in("passkey-es256@example.com", "Sup3r-secret!")
        .await;
    let begin_response = begin(&user.client, json!({ "name": "Laptop" })).await;
    let id = begin_response["id"].as_str().expect("id").to_string();
    assert!(id.starts_with("pkey_"));
    assert!(
        begin_response["public_key_credential_creation_options"]["challenge"]
            .as_str()
            .map(|challenge| challenge.len() > 10)
            .unwrap_or(false)
    );
    assert_eq!(
        begin_response["public_key_credential_creation_options"]["rp"]["id"],
        APP_RP_ID
    );
    assert_eq!(begin_response["name"], "Laptop");

    // No row exists before the attestation verifies.
    let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM passkeys WHERE id = $1")
        .bind(&id)
        .fetch_one(&h.state().pool)
        .await
        .expect("count");
    assert_eq!(before, 0);
    let listed = get_json(&user.client, "/v1/client/me/passkeys").await;
    assert_eq!(listed.value()["response"].as_array().map(Vec::len), Some(0));

    let mut authenticator = new_authenticator(VirtualAlgorithm::Es256);
    let credential = authenticator.register(
        &creation_options(&begin_response),
        CredentialOverrides::default(),
    );
    let credential_id = credential.id.clone();
    let serialized = serde_json::to_value(&credential).expect("credential json");
    let finished = finish(&user.client, &id, serialized, APP_ORIGIN).await;
    assert_status(&finished, StatusCode::OK);
    assert_eq!(finished.value()["response"]["id"], id);
    assert_eq!(finished.value()["response"]["name"], "Laptop");
    assert_eq!(finished.value()["response"]["object"], "passkey");

    #[derive(sqlx::FromRow)]
    struct Row {
        credential_id: String,
        counter: i64,
        transports: sqlx::types::Json<Vec<String>>,
        backed_up: bool,
        public_key: String,
    }
    let row = sqlx::query_as::<_, Row>(
        "SELECT credential_id, counter, transports, backed_up, public_key FROM passkeys WHERE id = $1",
    )
    .bind(&id)
    .fetch_one(&h.state().pool)
    .await
    .expect("row");
    assert_eq!(row.credential_id, credential_id);
    assert_eq!(row.counter, 0);
    assert_eq!(row.transports.0, vec!["internal", "hybrid"]);
    assert!(row.backed_up);
    assert!(!row.public_key.is_empty());

    let listed = get_json(&user.client, "/v1/client/me/passkeys").await;
    let listed_value = listed.value();
    let rows = listed_value["response"].as_array().expect("list");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["id"], id);
}

#[tokio::test]
async fn registers_an_rs256_security_key() {
    let h = harness().await;
    enable_passkeys(&h).await;
    let user = h
        .signed_in("passkey-rs256@example.com", "Sup3r-secret!")
        .await;
    let (passkey, _) = register(
        &user.client,
        new_authenticator(VirtualAlgorithm::Rs256),
        None,
        json!({ "authenticator_type": "cross-platform" }),
    )
    .await;
    let id = passkey["id"].as_str().expect("id");
    let transports: sqlx::types::Json<Vec<String>> =
        sqlx::query_scalar("SELECT transports FROM passkeys WHERE id = $1")
            .bind(id)
            .fetch_one(&h.state().pool)
            .await
            .expect("transports");
    assert_eq!(transports.0, vec!["internal", "hybrid"]);
}

#[tokio::test]
async fn lists_renames_and_deletes_passkeys_scoped_to_the_owner() {
    let h = harness().await;
    enable_passkeys(&h).await;
    let owner = h
        .signed_in("passkey-owner@example.com", "Sup3r-secret!")
        .await;
    let other = h
        .signed_in("passkey-other@example.com", "Sup3r-secret!")
        .await;
    let (passkey, _) = register(
        &owner.client,
        new_authenticator(VirtualAlgorithm::Es256),
        Some("Laptop"),
        json!({ "name": "Laptop" }),
    )
    .await;
    let id = passkey["id"].as_str().expect("id").to_string();

    let renamed = other
        .client
        .request(
            "PATCH",
            &format!("/v1/client/me/passkeys/{id}"),
            Some(json!({ "name": "Mine now" })),
            &[],
        )
        .await;
    assert_eq!(renamed.status, StatusCode::NOT_FOUND);
    let removed = other
        .client
        .request("DELETE", &format!("/v1/client/me/passkeys/{id}"), None, &[])
        .await;
    assert_eq!(removed.status, StatusCode::NOT_FOUND);

    let renamed = owner
        .client
        .request(
            "PATCH",
            &format!("/v1/client/me/passkeys/{id}"),
            Some(json!({ "name": "Work laptop" })),
            &[],
        )
        .await;
    assert_status(&renamed, StatusCode::OK);
    assert_eq!(renamed.value()["response"]["name"], "Work laptop");

    let empty = owner
        .client
        .request(
            "PATCH",
            &format!("/v1/client/me/passkeys/{id}"),
            Some(json!({ "name": "" })),
            &[],
        )
        .await;
    assert_eq!(empty.status, StatusCode::UNPROCESSABLE_ENTITY);

    let removed = owner
        .client
        .request("DELETE", &format!("/v1/client/me/passkeys/{id}"), None, &[])
        .await;
    assert_status(&removed, StatusCode::OK);
    assert_eq!(removed.value()["response"]["deleted"], true);
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM passkeys WHERE id = $1")
        .bind(&id)
        .fetch_one(&h.state().pool)
        .await
        .expect("count");
    assert_eq!(count, 0);
    let listed = get_json(&owner.client, "/v1/client/me/passkeys").await;
    assert_eq!(listed.value()["response"].as_array().map(Vec::len), Some(0));
}

#[tokio::test]
async fn rejects_wrong_challenge_rp_id_origin_and_user_verification() {
    let h = harness().await;
    enable_passkeys(&h).await;
    let user = h
        .signed_in("passkey-negative@example.com", "Sup3r-secret!")
        .await;

    for overrides in [
        CredentialOverrides {
            challenge: Some("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into()),
            ..CredentialOverrides::default()
        },
        CredentialOverrides {
            rp_id: Some("evil.example".into()),
            ..CredentialOverrides::default()
        },
        CredentialOverrides {
            origin: Some("https://evil.example".into()),
            ..CredentialOverrides::default()
        },
        CredentialOverrides {
            user_verified: Some(false),
            ..CredentialOverrides::default()
        },
    ] {
        let begin_response = begin(&user.client, json!({})).await;
        let id = begin_response["id"].as_str().expect("id").to_string();
        let mut authenticator = new_authenticator(VirtualAlgorithm::Es256);
        let credential = authenticator.register(&creation_options(&begin_response), overrides);
        let serialized = serde_json::to_value(&credential).expect("credential json");
        let response = finish(&user.client, &id, serialized, APP_ORIGIN).await;
        assert_eq!(
            response.status,
            StatusCode::BAD_REQUEST,
            "{}",
            response.text()
        );
        assert_eq!(error_codes(&response), vec!["passkey_registration_failure"]);
    }

    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM passkeys")
        .fetch_one(&h.state().pool)
        .await
        .expect("count");
    assert_eq!(count, 0);
}

#[tokio::test]
async fn rejects_expired_used_and_foreign_registration_challenges() {
    let h = harness().await;
    enable_passkeys(&h).await;
    let user = h
        .signed_in("passkey-expiry@example.com", "Sup3r-secret!")
        .await;

    // Expired.
    let begin_response = begin(&user.client, json!({})).await;
    let id = begin_response["id"].as_str().expect("id").to_string();
    sqlx::query(
        "UPDATE verifications SET expires_at = $1 \
         WHERE purpose = 'passkey_registration' AND owner_id = $2",
    )
    .bind(orbitid_core::http::now() - 1)
    .bind(&id)
    .execute(&h.state().pool)
    .await
    .expect("update");
    let mut authenticator = new_authenticator(VirtualAlgorithm::Es256);
    let credential = authenticator.register(
        &creation_options(&begin_response),
        CredentialOverrides::default(),
    );
    let serialized = serde_json::to_value(&credential).expect("credential json");
    let expired = finish(&user.client, &id, serialized, APP_ORIGIN).await;
    assert_eq!(expired.status, StatusCode::BAD_REQUEST);
    assert_eq!(error_codes(&expired), vec!["verification_expired"]);

    // Replayed ceremony.
    let begin_response = begin(&user.client, json!({})).await;
    let id = begin_response["id"].as_str().expect("id").to_string();
    let mut authenticator = new_authenticator(VirtualAlgorithm::Es256);
    let credential = authenticator.register(
        &creation_options(&begin_response),
        CredentialOverrides::default(),
    );
    let serialized = serde_json::to_value(&credential).expect("credential json");
    let first = finish(&user.client, &id, serialized.clone(), APP_ORIGIN).await;
    assert_status(&first, StatusCode::OK);
    let replay = finish(&user.client, &id, serialized, APP_ORIGIN).await;
    assert_eq!(replay.status, StatusCode::BAD_REQUEST);
    assert_eq!(error_codes(&replay), vec!["verification_expired"]);

    // Another user's challenge.
    let other = h
        .signed_in("passkey-foreign@example.com", "Sup3r-secret!")
        .await;
    let begin_response = begin(&user.client, json!({})).await;
    let id = begin_response["id"].as_str().expect("id").to_string();
    let mut authenticator = new_authenticator(VirtualAlgorithm::Es256);
    let credential = authenticator.register(
        &creation_options(&begin_response),
        CredentialOverrides::default(),
    );
    let serialized = serde_json::to_value(&credential).expect("credential json");
    let foreign = finish(&other.client, &id, serialized, APP_ORIGIN).await;
    assert_eq!(foreign.status, StatusCode::BAD_REQUEST);
    assert_eq!(error_codes(&foreign), vec!["verification_expired"]);
}

#[tokio::test]
async fn rejects_passkey_management_when_disabled_or_unauthenticated() {
    let h = harness().await;
    let user = h
        .signed_in("passkey-disabled@example.com", "Sup3r-secret!")
        .await;
    let disabled = user
        .client
        .request(
            "POST",
            "/v1/client/me/passkeys",
            Some(json!({})),
            &[("origin", APP_ORIGIN)],
        )
        .await;
    assert_eq!(disabled.status, StatusCode::BAD_REQUEST);
    assert_eq!(error_codes(&disabled), vec!["webauthn_not_supported"]);

    let anonymous = h.client();
    let denied = anonymous
        .request(
            "POST",
            "/v1/client/me/passkeys",
            Some(json!({})),
            &[("origin", APP_ORIGIN)],
        )
        .await;
    assert_eq!(denied.status, StatusCode::UNAUTHORIZED);

    enable_passkeys(&h).await;
    let invalid_type = user
        .client
        .request(
            "POST",
            "/v1/client/me/passkeys",
            Some(json!({ "authenticator_type": "nope" })),
            &[("origin", APP_ORIGIN)],
        )
        .await;
    assert_eq!(invalid_type.status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn relying_party_uses_the_trusted_origin_and_falls_back() {
    let h = harness().await;
    enable_passkeys(&h).await;
    h.state()
        .settings
        .update(json!({ "application": { "homeUrl": "https://app.example.com" } }))
        .await
        .expect("settings");
    let user = h.signed_in("passkey-rp@example.com", "Sup3r-secret!").await;

    let trusted = begin_with_origin(&user.client, "https://app.example.com").await;
    assert_status(&trusted, StatusCode::OK);
    assert_eq!(
        trusted.value()["response"]["public_key_credential_creation_options"]["rp"]["id"],
        "app.example.com"
    );

    // An untrusted origin falls back to the configured app URL. The HTTP layer
    // refuses a cross-site Origin before the handler runs, so the helper is
    // exercised directly here.
    let fallback = orbitid_credentials::relying_party(h.state(), Some("https://evil.example"))
        .expect("fallback relying party");
    assert_eq!(fallback.rp_id, "app.example.com");
    assert_eq!(fallback.origin, "https://app.example.com");
}

async fn begin_with_origin(
    client: &TestClient,
    origin: &str,
) -> orbitid_core::testing::TestResponse {
    client
        .request(
            "POST",
            "/v1/client/me/passkeys",
            Some(json!({})),
            &[("origin", origin)],
        )
        .await
}

#[tokio::test]
async fn finish_can_supply_the_passkey_name() {
    let h = harness().await;
    enable_passkeys(&h).await;
    let user = h
        .signed_in("passkey-finish-name@example.com", "Sup3r-secret!")
        .await;
    let begin_response = begin(&user.client, json!({})).await;
    let id = begin_response["id"].as_str().expect("id").to_string();
    let mut authenticator = new_authenticator(VirtualAlgorithm::Es256);
    let credential = authenticator.register(
        &creation_options(&begin_response),
        CredentialOverrides::default(),
    );
    let serialized = serde_json::to_value(&credential).expect("credential json");
    let finished = user
        .client
        .request(
            "POST",
            &format!("/v1/client/me/passkeys/{id}/attempt_verification"),
            Some(json!({ "public_key_credential": serialized, "name": "Phone" })),
            &[("origin", APP_ORIGIN)],
        )
        .await;
    assert_status(&finished, StatusCode::OK);
    assert_eq!(finished.value()["response"]["name"], "Phone");
}
