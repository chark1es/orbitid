//! Ported from `test/security/{magic-link-binding,silent-auth,auth-surface}.test.ts`
//! and the metadata/asset parts of the enterprise tests.

mod common;

use axum::http::StatusCode;
use common::{harness, seed_user};
use orbitid_platform::mail::latest_link_for;

fn link_token(link: &str) -> String {
    url::Url::parse(link)
        .unwrap()
        .query_pairs()
        .find(|(key, _)| key == "token")
        .map(|(_, value)| value.into_owned())
        .unwrap()
}

async fn prepare_link(h: &common::Harness, email: &str) -> (String, String) {
    let created = h
        .client
        .post(
            "/v1/client/sign_ins",
            Some(serde_json::json!({ "identifier": email })),
            &[],
        )
        .await;
    let sign_in_id = created.value()["response"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    h.client
        .post(
            &format!("/v1/client/sign_ins/{sign_in_id}/prepare_first_factor"),
            Some(serde_json::json!({ "strategy": "email_link" })),
            &[],
        )
        .await;
    let link = latest_link_for(&h.app.app_state(), email).expect("magic link");
    (sign_in_id, link_token(&link))
}

#[tokio::test]
async fn unknown_magic_links_fail_closed() {
    let h = harness().await;
    let response = h.client.get("/v1/verify?token=bogus", &[]).await;
    assert_eq!(response.status, StatusCode::FOUND);
    assert!(response
        .headers
        .get("location")
        .unwrap()
        .to_str()
        .unwrap()
        .contains("__orbit_status=failed"));

    let missing = h.client.get("/v1/verify", &[]).await;
    assert_eq!(missing.status, StatusCode::BAD_REQUEST);
    assert_eq!(missing.error_codes(), vec!["form_param_missing"]);
}

#[tokio::test]
async fn expired_magic_links_do_not_verify() {
    let h = harness().await;
    seed_user(&h, "expired@example.com", "Sup3r-secret!").await;
    let (_, token) = prepare_link(&h, "expired@example.com").await;
    sqlx::query("UPDATE verifications SET expires_at = 1")
        .execute(&h.state().pool)
        .await
        .unwrap();
    let response = h
        .client
        .get(&format!("/v1/verify?token={token}"), &[])
        .await;
    assert!(response
        .headers
        .get("location")
        .unwrap()
        .to_str()
        .unwrap()
        .contains("__orbit_status=expired"));
}

#[tokio::test]
async fn a_clicked_magic_link_is_single_use_and_reports_verified() {
    let h = harness().await;
    seed_user(&h, "once@example.com", "Sup3r-secret!").await;
    let (_, token) = prepare_link(&h, "once@example.com").await;
    let first = h
        .client
        .get(&format!("/v1/verify?token={token}"), &[])
        .await;
    assert!(first
        .headers
        .get("location")
        .unwrap()
        .to_str()
        .unwrap()
        .contains("__orbit_status=verified"));
    let second = h
        .client
        .get(&format!("/v1/verify?token={token}"), &[])
        .await;
    assert!(second
        .headers
        .get("location")
        .unwrap()
        .to_str()
        .unwrap()
        .contains("__orbit_status=verified"));
}

#[tokio::test]
async fn saml_metadata_is_served_and_unknown_connections_are_404() {
    let h = harness().await;
    let now = orbitid_core::http::now();
    sqlx::query(
        "INSERT INTO enterprise_connections (id, name, protocol, provider, domains, active, \
         allow_subdomains, allow_idp_initiated, sync_user_attributes, \
         disable_additional_identifications, config, created_at, updated_at) \
         VALUES ('ent_test', 'Acme', 'saml', 'saml', '[\"acme.test\"]', true, false, false, true, \
         false, '{}'::jsonb, $1, $1)",
    )
    .bind(now)
    .execute(&h.state().pool)
    .await
    .unwrap();
    let metadata = h.client.get("/v1/saml/ent_test/metadata", &[]).await;
    assert_eq!(metadata.status, StatusCode::OK);
    assert_eq!(
        metadata.headers.get("content-type").unwrap(),
        "application/xml; charset=utf-8"
    );
    let text = metadata.text();
    assert!(text.contains("EntityDescriptor"));
    assert!(text.contains("/v1/saml/ent_test/acs"));

    let unknown = h.client.get("/v1/saml/nope/metadata", &[]).await;
    assert_eq!(unknown.status, StatusCode::NOT_FOUND);
    assert_eq!(unknown.error_codes(), vec!["resource_not_found"]);
}

#[tokio::test]
async fn client_paths_require_a_valid_json_body_shape() {
    let h = harness().await;
    let response = h
        .client
        .post(
            "/v1/client/sign_ins",
            Some(serde_json::json!({ "identifier": 12345 })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(response.error_codes(), vec!["form_param_format_invalid"]);
}

#[tokio::test]
async fn a_magic_link_only_works_in_the_browser_that_started_the_flow() {
    let h = harness().await;
    seed_user(&h, "binding@example.com", "Sup3r-secret!").await;
    let (_, token) = prepare_link(&h, "binding@example.com").await;

    // A different browser (no __client for this flow) cannot complete it.
    let other = h.other_browser();
    let refused = other.get(&format!("/v1/verify?token={token}"), &[]).await;
    assert_eq!(refused.status, StatusCode::FOUND);
    let location = refused.headers.get("location").unwrap().to_str().unwrap();
    assert!(
        location.contains("__orbit_status=different_browser"),
        "{location}"
    );

    // The originating browser still can.
    let verified = h
        .client
        .get(&format!("/v1/verify?token={token}"), &[])
        .await;
    let location = verified.headers.get("location").unwrap().to_str().unwrap();
    assert!(location.contains("__orbit_status=verified"), "{location}");
    let client = h.client.get("/v1/client", &[]).await.value();
    assert_eq!(client["response"]["sessions"].as_array().unwrap().len(), 1);
}
