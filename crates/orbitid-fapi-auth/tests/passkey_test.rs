//! Ported from `test/passkeys-signin.test.ts`.

mod common;

use axum::http::StatusCode;
use common::{harness, seed_user};
use orbitid_credentials::passkeys::{
    begin_passkey_registration, finish_passkey_registration, relying_party, BeginRegistrationInput,
    FinishRegistrationInput,
};
use orbitid_credentials::RequestOptionsJson;
use orbitid_credentials::{CredentialOverrides, VirtualAuthenticator, VirtualAuthenticatorOptions};

async fn register_passkey(h: &common::Harness, user_id: &str, email: &str) -> VirtualAuthenticator {
    h.state()
        .settings
        .update(serde_json::json!({
            "attributes": { "passkey": { "enabled": true, "usedForFirstFactor": true } }
        }))
        .await
        .unwrap();
    let rp = relying_party(h.state(), None).unwrap();
    let begin = begin_passkey_registration(
        h.state(),
        BeginRegistrationInput {
            user_id: user_id.to_string(),
            user_name: email.to_string(),
            display_name: email.to_string(),
            rp: rp.clone(),
            authenticator_type: None,
            name: None,
        },
    )
    .await
    .unwrap();
    let mut authenticator = VirtualAuthenticator::new(VirtualAuthenticatorOptions::new(
        rp.rp_id.clone(),
        rp.origin.clone(),
    ))
    .unwrap();
    let credential = authenticator.register(&begin.options, CredentialOverrides::default());
    finish_passkey_registration(
        h.state(),
        FinishRegistrationInput {
            passkey_id: begin.passkey_id,
            user_id: user_id.to_string(),
            credential,
            name: None,
        },
    )
    .await
    .unwrap();
    authenticator
}

fn request_options(nonce: &str) -> RequestOptionsJson {
    serde_json::from_str::<RequestOptionsJson>(nonce).expect("request options")
}

#[tokio::test]
async fn passkey_sign_in_with_an_identifier() {
    let h = harness().await;
    let user = seed_user(&h, "passkey@example.com", "Sup3r-secret!").await;
    let mut authenticator = register_passkey(&h, &user.user.id, "passkey@example.com").await;

    let created = h
        .client
        .post(
            "/v1/client/sign_ins",
            Some(serde_json::json!({ "identifier": "passkey@example.com" })),
            &[],
        )
        .await;
    let sign_in_id = created.value()["response"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let prepared = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{sign_in_id}/prepare_first_factor"),
            Some(serde_json::json!({ "strategy": "passkey" })),
            &[],
        )
        .await;
    assert_eq!(prepared.status, StatusCode::OK, "{}", prepared.text());
    let nonce = prepared.value()["response"]["first_factor_verification"]["nonce"]
        .as_str()
        .unwrap()
        .to_string();
    let options = request_options(&nonce);
    let credential = authenticator.authenticate(&options, CredentialOverrides::default());

    let attempted = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{sign_in_id}/attempt_first_factor"),
            Some(serde_json::json!({
                "strategy": "passkey",
                "public_key_credential": credential,
            })),
            &[],
        )
        .await;
    assert_eq!(attempted.status, StatusCode::OK, "{}", attempted.text());
    assert_eq!(attempted.value()["response"]["status"], "complete");
}

#[tokio::test]
async fn discoverable_passkey_sign_in_needs_no_identifier() {
    let h = harness().await;
    let user = seed_user(&h, "passkey@example.com", "Sup3r-secret!").await;
    let mut authenticator = register_passkey(&h, &user.user.id, "passkey@example.com").await;

    let created = h
        .client
        .post(
            "/v1/client/sign_ins",
            Some(serde_json::json!({ "strategy": "passkey" })),
            &[],
        )
        .await;
    assert_eq!(created.status, StatusCode::OK, "{}", created.text());
    let value = created.value();
    assert_eq!(value["response"]["status"], "needs_first_factor");
    assert_eq!(
        value["response"]["first_factor_verification"]["strategy"],
        "passkey"
    );
    let sign_in_id = value["response"]["id"].as_str().unwrap().to_string();

    let prepared = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{sign_in_id}/prepare_first_factor"),
            Some(serde_json::json!({ "strategy": "passkey" })),
            &[],
        )
        .await;
    assert_eq!(prepared.status, StatusCode::OK, "{}", prepared.text());
    let nonce = prepared.value()["response"]["first_factor_verification"]["nonce"]
        .as_str()
        .unwrap()
        .to_string();
    let options = request_options(&nonce);
    let credential = authenticator.authenticate(&options, CredentialOverrides::default());
    let attempted = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{sign_in_id}/attempt_first_factor"),
            Some(serde_json::json!({
                "strategy": "passkey",
                "public_key_credential": credential,
            })),
            &[],
        )
        .await;
    assert_eq!(attempted.status, StatusCode::OK, "{}", attempted.text());
    assert_eq!(attempted.value()["response"]["status"], "complete");
    assert!(attempted.value()["response"]["identifier"].is_null());
}

#[tokio::test]
async fn a_foreign_origin_assertion_is_refused() {
    let h = harness().await;
    let user = seed_user(&h, "passkey@example.com", "Sup3r-secret!").await;
    let mut authenticator = register_passkey(&h, &user.user.id, "passkey@example.com").await;
    let created = h
        .client
        .post(
            "/v1/client/sign_ins",
            Some(serde_json::json!({ "strategy": "passkey" })),
            &[],
        )
        .await;
    let sign_in_id = created.value()["response"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let prepared = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{sign_in_id}/prepare_first_factor"),
            Some(serde_json::json!({ "strategy": "passkey" })),
            &[],
        )
        .await;
    let nonce = prepared.value()["response"]["first_factor_verification"]["nonce"]
        .as_str()
        .unwrap()
        .to_string();
    let options = request_options(&nonce);
    let credential = authenticator.authenticate(
        &options,
        CredentialOverrides {
            origin: Some("https://evil.example".into()),
            ..Default::default()
        },
    );
    let attempted = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{sign_in_id}/attempt_first_factor"),
            Some(serde_json::json!({
                "strategy": "passkey",
                "public_key_credential": credential,
            })),
            &[],
        )
        .await;
    assert_eq!(attempted.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        attempted.error_codes(),
        vec!["passkey_authentication_failure"]
    );
}
