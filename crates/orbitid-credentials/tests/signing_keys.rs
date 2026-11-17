//! Instance signing keys, JWKS and session token verification against the
//! Postgres-backed key store.

use serde_json::Value;

use orbitid_core::models::SigningKeyRow;
use orbitid_core::testing::test_state;
use orbitid_credentials::jwt::{Jwk, JwkSet, VerifyOptions};
use orbitid_credentials::{
    assert_signing_keys_readable, get_active_signing_key, get_jwks, rotate_signing_key, sign_jwt,
    verify_session_token, SignJwtOptions, VerifySessionOptions,
};

const FIXTURE: &str = include_str!("fixtures/cross_compat.json");

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).unwrap()
}

async fn insert_fixture_key(state: &orbitid_core::AppState) {
    let fixture = fixture();
    sqlx::query(
        "INSERT INTO signing_keys (kid, alg, public_jwk, private_jwk_enc, active, created_at) \
         VALUES ($1, 'RS256', $2, $3, true, $4)",
    )
    .bind("fixturekid")
    .bind(sqlx::types::Json(&fixture["rsa_public_jwk"]))
    .bind(fixture["rsa_private_jwk_enc"].as_str().unwrap())
    .bind(1_700_000_000_000i64)
    .execute(&state.pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn mints_the_first_key_and_keeps_it_stable() {
    let context = test_state().await;
    let state = &context.state;
    let jwks = get_jwks(state).await.unwrap();
    assert_eq!(jwks.len(), 1);
    assert_eq!(jwks[0]["kty"], "RSA");
    assert_eq!(jwks[0]["alg"], "RS256");
    assert_eq!(jwks[0]["use"], "sig");
    let kid = jwks[0]["kid"].as_str().unwrap().to_string();
    assert!(!kid.is_empty());

    let active = get_active_signing_key(state).await.unwrap();
    assert_eq!(active.row.kid, kid);
    assert!(active.row.active);
    assert_eq!(get_active_signing_key(state).await.unwrap().row.kid, kid);
    assert_eq!(get_jwks(state).await.unwrap().len(), 1);
    assert_signing_keys_readable(state).await.unwrap();
}

#[tokio::test]
async fn concurrent_first_boots_create_exactly_one_active_key() {
    let context = test_state().await;
    let state = context.state.clone();
    let first = tokio::spawn({
        let state = state.clone();
        async move { get_active_signing_key(&state).await.map(|key| key.row.kid) }
    });
    let second = tokio::spawn({
        let state = state.clone();
        async move { get_active_signing_key(&state).await.map(|key| key.row.kid) }
    });
    let first = first.await.unwrap().unwrap();
    let second = second.await.unwrap().unwrap();
    assert_eq!(first, second);
    let active: Vec<SigningKeyRow> =
        sqlx::query_as("SELECT * FROM signing_keys WHERE active = true")
            .fetch_all(&state.pool)
            .await
            .unwrap();
    assert_eq!(active.len(), 1);
}

#[tokio::test]
async fn verifies_a_typescript_signed_session_token() {
    let context = test_state().await;
    let state = &context.state;
    insert_fixture_key(state).await;
    let fixture = fixture();
    let claims = verify_session_token(
        state,
        fixture["session_jwt_rs256"].as_str().unwrap(),
        VerifySessionOptions::default(),
    )
    .await
    .unwrap();
    assert_eq!(claims.sub, "user_fixture");
    assert_eq!(claims.sid, "sess_fixture");
    assert_eq!(claims.iss, "http://localhost:4000");
    assert_eq!(claims.extra["custom"], "kept");

    // The same token is not accepted as a JWT template token.
    assert!(verify_session_token(
        state,
        fixture["session_jwt_rs256"].as_str().unwrap(),
        VerifySessionOptions {
            token_type: Some(orbitid_credentials::TokenType::JwtTemplate),
        },
    )
    .await
    .is_err());
}

#[tokio::test]
async fn signs_with_a_specific_kid_and_verifies_with_the_public_jwk() {
    let context = test_state().await;
    let state = &context.state;
    insert_fixture_key(state).await;
    let fixture = fixture();
    let mut claims = serde_json::Map::new();
    claims.insert("hello".into(), Value::String("world".into()));
    let jwt = sign_jwt(
        state,
        &claims,
        SignJwtOptions {
            expires_in_seconds: 300,
            audience: Some("https://api.example.test".into()),
            issuer: None,
            kid: Some("fixturekid".into()),
        },
    )
    .await
    .unwrap();
    let jwk = Jwk::from_value(&fixture["rsa_public_jwk"]).unwrap();
    let payload = orbitid_credentials::jwt::verify_jws(
        &jwt,
        &JwkSet::new(vec![jwk]),
        &VerifyOptions {
            algorithms: vec![orbitid_credentials::JwsAlgorithm::RS256],
            issuer: Some(vec!["http://localhost:4000".into()]),
            audience: Some(vec!["https://api.example.test".into()]),
            clock_tolerance_seconds: 5,
        },
    )
    .unwrap();
    assert_eq!(payload["hello"], "world");
}

#[tokio::test]
async fn rotation_keeps_old_public_keys_and_marks_them_inactive() {
    let context = test_state().await;
    let state = &context.state;
    let first = get_active_signing_key(state).await.unwrap().row.kid;
    let new_kid = rotate_signing_key(state).await.unwrap();
    assert_ne!(first, new_kid);
    let rows: Vec<SigningKeyRow> =
        sqlx::query_as("SELECT * FROM signing_keys ORDER BY created_at ASC")
            .fetch_all(&state.pool)
            .await
            .unwrap();
    assert_eq!(rows.len(), 2);
    let old = rows.iter().find(|row| row.kid == first).unwrap();
    assert!(!old.active);
    assert!(old.rotated_at.is_some());
    let new = rows.iter().find(|row| row.kid == new_kid).unwrap();
    assert!(new.active);
    assert_eq!(get_jwks(state).await.unwrap().len(), 2);

    // A token signed with the rotated key still verifies.
    let mut claims = serde_json::Map::new();
    claims.insert("role".into(), Value::String("rotation".into()));
    let jwt = sign_jwt(
        state,
        &claims,
        SignJwtOptions {
            expires_in_seconds: 60,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let payload = orbitid_credentials::jwt::verify_jws(
        &jwt,
        &JwkSet::new(
            get_jwks(state)
                .await
                .unwrap()
                .iter()
                .map(|value| Jwk::from_value(value).unwrap())
                .collect(),
        ),
        &VerifyOptions {
            algorithms: vec![orbitid_credentials::JwsAlgorithm::RS256],
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(payload["role"], "rotation");
}

#[tokio::test]
async fn unreadable_keys_fail_loudly_without_regenerating() {
    let context = test_state().await;
    let state = &context.state;
    sqlx::query(
        "INSERT INTO signing_keys (kid, alg, public_jwk, private_jwk_enc, active, created_at) \
         VALUES ('brokenkid', 'RS256', '{}', 'v1.AAAA.BBBB.CCCC', true, 1)",
    )
    .execute(&state.pool)
    .await
    .unwrap();
    let error = assert_signing_keys_readable(state).await.unwrap_err();
    assert!(error.message.contains("brokenkid"));
    assert!(error.message.contains("No key was regenerated"));
    let rows: Vec<SigningKeyRow> = sqlx::query_as("SELECT * FROM signing_keys")
        .fetch_all(&state.pool)
        .await
        .unwrap();
    assert_eq!(rows.len(), 1);
}

#[tokio::test]
async fn jwks_router_serves_the_keys_with_a_cache_header() {
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    let context = test_state().await;
    let app = orbitid_credentials::jwks_router().with_state(context.state.clone());
    let response = app
        .oneshot(
            Request::builder()
                .uri("/.well-known/jwks.json")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "public, max-age=300");
    let body = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let value: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["keys"].as_array().unwrap().len(), 1);
}
