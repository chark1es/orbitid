//! JWT templates, session token minting and verification.

mod common;

use serde_json::{json, Value};
use sqlx::PgPool;

use orbitid_core::http::now;
use orbitid_core::models::JwtTemplateRow;
use orbitid_core::testing::test_state;
use orbitid_credentials::jwt::{Jwk, JwkSet, JwsAlgorithm, VerifyOptions};
use orbitid_credentials::{
    assert_allowed_claims, build_shortcode_context, generate_template_signing_key, get_jwks,
    render_template_claims, sign_session_token, template_verification_key, verify_session_token,
    SessionTokenInput, SessionTokenOptions, TemplateRenderInput, TokenOrg, TokenType,
    VerifySessionOptions,
};

async fn insert_org(pool: &PgPool, user_id: &str) -> String {
    let timestamp = now();
    sqlx::query(
        "INSERT INTO organizations (id, name, slug, public_metadata, private_metadata, created_at, updated_at) \
         VALUES ('org_acme', 'Acme', 'acme', '{\"plan\":\"enterprise\"}', '{}', $1, $1)",
    )
    .bind(timestamp)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO organization_memberships (id, organization_id, user_id, role_key, public_metadata, private_metadata, created_at, updated_at) \
         VALUES ('orgmem_ada', 'org_acme', $1, 'org:member', '{}', '{}', $2, $2)",
    )
    .bind(user_id)
    .bind(timestamp)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO roles (id, key, name, is_system, created_at, updated_at) \
         VALUES ('role_member', 'org:member', 'Member', true, $1, $1) \
         ON CONFLICT DO NOTHING",
    )
    .bind(timestamp)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO permissions (id, key, name, type, created_at, updated_at) \
         VALUES ('perm_memberships_read', 'org:sys_memberships:read', 'Read memberships', 'system', $1, $1) \
         ON CONFLICT DO NOTHING",
    )
    .bind(timestamp)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO role_permissions (role_id, permission_id) VALUES ('role_member', 'perm_memberships_read') \
         ON CONFLICT DO NOTHING",
    )
    .execute(pool)
    .await
    .unwrap();
    "org_acme".to_string()
}

async fn insert_template(pool: &PgPool, name: &str, claims: Value, lifetime: i64) {
    let timestamp = now();
    sqlx::query(
        "INSERT INTO jwt_templates (id, name, claims, lifetime, allowed_clock_skew, custom_signing_key, \
         signing_algorithm, created_at, updated_at) \
         VALUES ($1, $2, $3, $4, 5, false, 'RS256', $5, $5)",
    )
    .bind(format!("jtmpl_{name}"))
    .bind(name)
    .bind(sqlx::types::Json(&claims))
    .bind(lifetime)
    .bind(timestamp)
    .execute(pool)
    .await
    .unwrap();
}

async fn template_row(pool: &PgPool, name: &str) -> JwtTemplateRow {
    sqlx::query_as("SELECT * FROM jwt_templates WHERE name = $1")
        .bind(name)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn builds_the_shortcode_context_and_renders_a_stored_template() {
    let context = test_state().await;
    let state = &context.state;
    let user = common::insert_user(&state.pool, "user_ada", "ada@example.com").await;
    let org_id = insert_org(&state.pool, &user.id).await;
    let session_id = common::insert_session(&state.pool, "sess_ada", &user.id).await;
    sqlx::query("UPDATE sessions SET last_active_organization_id = $1 WHERE id = $2")
        .bind(&org_id)
        .bind(&session_id)
        .execute(&state.pool)
        .await
        .unwrap();

    let shortcodes = build_shortcode_context(
        state,
        TemplateRenderInput {
            user_id: user.id.clone(),
            session_id: Some(session_id.clone()),
            org_id: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(shortcodes["user"]["id"], "user_ada");
    assert_eq!(shortcodes["user"]["full_name"], "Ada Lovelace");
    assert_eq!(
        shortcodes["user"]["primary_email_address"],
        "ada@example.com"
    );
    assert_eq!(shortcodes["user"]["email_verified"], true);
    assert_eq!(shortcodes["org"]["slug"], "acme");
    assert_eq!(shortcodes["org"]["role"], "org:member");
    assert_eq!(shortcodes["session"]["id"], "sess_ada");

    insert_template(
        &state.pool,
        "claims",
        json!({
            "email": "{{user.primary_email_address}}",
            "name": "{{user.full_name || user.username}}",
            "org": "{{org.slug}}",
            "tier": "{{user.public_metadata.tier}}",
            "nested": "{{user.public_metadata.team.name}}",
            "perms": "{{org_membership.permissions}}",
            "missing": "{{user.nope}}",
            "latin": "{{user.last_name}}",
        }),
        120,
    )
    .await;
    let rendered = render_template_claims(
        state,
        "claims",
        TemplateRenderInput {
            user_id: user.id.clone(),
            session_id: Some(session_id),
            org_id: None,
        },
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(rendered.lifetime_seconds, 120);
    assert_eq!(rendered.allowed_clock_skew_seconds, 5);
    assert_eq!(rendered.algorithm, "RS256");
    assert!(rendered.signing_key_enc.is_none());
    assert_eq!(rendered.claims["email"], "ada@example.com");
    assert_eq!(rendered.claims["name"], "Ada Lovelace");
    assert_eq!(rendered.claims["org"], "acme");
    assert_eq!(rendered.claims["tier"], "pro");
    assert_eq!(rendered.claims["nested"], "core");
    assert_eq!(rendered.claims["latin"], "Lovelace");
    assert!(!rendered.claims.contains_key("missing"));
    assert_eq!(
        rendered.claims["perms"],
        json!(["org:sys_memberships:read"])
    );

    let missing = render_template_claims(
        state,
        "missing",
        TemplateRenderInput {
            user_id: user.id,
            session_id: None,
            org_id: None,
        },
    )
    .await
    .unwrap();
    assert!(missing.is_none());
}

#[tokio::test]
async fn template_tokens_are_marked_and_refused_as_sessions() {
    let context = test_state().await;
    let state = &context.state;
    let user = common::insert_user(&state.pool, "user_ada", "ada@example.com").await;
    let session_id = common::insert_session(&state.pool, "sess_ada", &user.id).await;
    insert_template(
        &state.pool,
        "long-lived",
        json!({"plan": "pro"}),
        315_360_000,
    )
    .await;
    let user_json = common::user_json(&user);
    let session = sqlx::query_as("SELECT * FROM sessions WHERE id = $1")
        .bind(&session_id)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    let jwt = sign_session_token(
        state,
        SessionTokenInput {
            session: &session,
            user: &user,
            user_json: &user_json,
            org: None,
            roles: vec![],
            role_permissions: vec![],
        },
        SessionTokenOptions {
            template: Some("long-lived"),
            azp: None,
        },
    )
    .await
    .unwrap();
    let payload = orbitid_credentials::decode_jwt_payload(&jwt).unwrap();
    assert_eq!(payload["token_type"], "jwt_template");
    assert_eq!(payload["plan"], "pro");
    assert_eq!(
        payload["exp"].as_i64().unwrap() - payload["iat"].as_i64().unwrap(),
        315_360_000
    );
    assert!(
        verify_session_token(state, &jwt, VerifySessionOptions::default())
            .await
            .is_err()
    );
    let claims = verify_session_token(
        state,
        &jwt,
        VerifySessionOptions {
            token_type: Some(TokenType::JwtTemplate),
        },
    )
    .await
    .unwrap();
    assert_eq!(claims.sub, "user_ada");
    assert_eq!(claims.sid, "sess_ada");

    let session_jwt = sign_session_token(
        state,
        SessionTokenInput {
            session: &session,
            user: &user,
            user_json: &user_json,
            org: None,
            roles: vec![],
            role_permissions: vec![],
        },
        SessionTokenOptions::default(),
    )
    .await
    .unwrap();
    assert!(
        verify_session_token(state, &session_jwt, VerifySessionOptions::default())
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn custom_session_claims_cannot_override_reserved_claims() {
    let context = test_state().await;
    let state = &context.state;
    let user = common::insert_user(&state.pool, "user_ada", "ada@example.com").await;
    let session_id = common::insert_session(&state.pool, "sess_ada", &user.id).await;
    state
        .settings
        .update(json!({
            "session": { "customClaims": {
                "sts": "active",
                "org_role": "org:admin",
                "org_name": "Acme",
                "plan": "pro",
                "email": "{{user.primary_email_address}}"
            }}
        }))
        .await
        .unwrap();
    let user_json = common::user_json(&user);
    let session = sqlx::query_as("SELECT * FROM sessions WHERE id = $1")
        .bind(&session_id)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    let jwt = sign_session_token(
        state,
        SessionTokenInput {
            session: &session,
            user: &user,
            user_json: &user_json,
            org: None,
            roles: vec!["app:analyst".into()],
            role_permissions: vec!["app:batch:0".into()],
        },
        SessionTokenOptions::default(),
    )
    .await
    .unwrap();
    let payload = orbitid_credentials::decode_jwt_payload(&jwt).unwrap();
    assert_eq!(payload["sts"], "active");
    assert!(payload.get("org_role").is_none());
    assert_eq!(payload["org_name"], "Acme");
    assert_eq!(payload["plan"], "pro");
    assert_eq!(payload["email"], "ada@example.com");
    assert_eq!(payload["roles"], json!(["app:analyst"]));
    assert_eq!(payload["role_permissions"], json!(["app:batch:0"]));
    assert_eq!(
        payload["exp"].as_i64().unwrap() - payload["iat"].as_i64().unwrap(),
        state.settings.get().session.token_lifetime_seconds
    );

    assert!(assert_allowed_claims(json!({"sub": "x"}).as_object().unwrap()).is_err());
}

#[tokio::test]
async fn template_custom_keys_sign_with_the_template_algorithm() {
    let context = test_state().await;
    let state = &context.state;
    let user = common::insert_user(&state.pool, "user_ada", "ada@example.com").await;
    let session_id = common::insert_session(&state.pool, "sess_ada", &user.id).await;
    insert_template(
        &state.pool,
        "partner",
        json!({"email": "{{user.primary_email_address}}"}),
        60,
    )
    .await;
    let user_json = common::user_json(&user);
    let session = sqlx::query_as("SELECT * FROM sessions WHERE id = $1")
        .bind(&session_id)
        .fetch_one(&state.pool)
        .await
        .unwrap();

    // HS256: the verification key is the plain secret.
    let encrypted = generate_template_signing_key(state, "HS256").await.unwrap();
    sqlx::query(
        "UPDATE jwt_templates SET custom_signing_key = true, signing_algorithm = 'HS256', \
         signing_key_enc = $1 WHERE name = 'partner'",
    )
    .bind(&encrypted)
    .execute(&state.pool)
    .await
    .unwrap();
    let row = template_row(&state.pool, "partner").await;
    let secret = template_verification_key(state, &row).unwrap().unwrap();
    let jwt = sign_session_token(
        state,
        SessionTokenInput {
            session: &session,
            user: &user,
            user_json: &user_json,
            org: None,
            roles: vec![],
            role_permissions: vec![],
        },
        SessionTokenOptions {
            template: Some("partner"),
            azp: None,
        },
    )
    .await
    .unwrap();
    let header = orbitid_credentials::decode_jwt_payload(&jwt).unwrap();
    assert_eq!(header["email"], "ada@example.com");
    let key = Jwk::from_value(&json!({
        "kty": "oct",
        "k": base64_url(secret.as_str().unwrap().as_bytes()),
        "alg": "HS256"
    }))
    .unwrap();
    let payload =
        orbitid_credentials::verify_jws(&jwt, &JwkSet::new(vec![key]), &VerifyOptions::default())
            .unwrap();
    assert_eq!(payload["email"], "ada@example.com");

    // RS256: only the public half is exposed.
    let encrypted = generate_template_signing_key(state, "RS256").await.unwrap();
    sqlx::query(
        "UPDATE jwt_templates SET signing_algorithm = 'RS256', signing_key_enc = $1 WHERE name = 'partner'",
    )
    .bind(&encrypted)
    .execute(&state.pool)
    .await
    .unwrap();
    let row = template_row(&state.pool, "partner").await;
    let public = template_verification_key(state, &row).unwrap().unwrap();
    assert!(public.get("d").is_none());
    let jwt = sign_session_token(
        state,
        SessionTokenInput {
            session: &session,
            user: &user,
            user_json: &user_json,
            org: None,
            roles: vec![],
            role_permissions: vec![],
        },
        SessionTokenOptions {
            template: Some("partner"),
            azp: None,
        },
    )
    .await
    .unwrap();
    let key = Jwk::from_value(&public).unwrap();
    let payload = orbitid_credentials::verify_jws(
        &jwt,
        &JwkSet::new(vec![key]),
        &VerifyOptions {
            algorithms: vec![JwsAlgorithm::RS256],
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(payload["email"], "ada@example.com");

    // ES256: the template key is a P-256 private JWK.
    let encrypted = generate_template_signing_key(state, "ES256").await.unwrap();
    sqlx::query(
        "UPDATE jwt_templates SET signing_algorithm = 'ES256', signing_key_enc = $1 WHERE name = 'partner'",
    )
    .bind(&encrypted)
    .execute(&state.pool)
    .await
    .unwrap();
    let row = template_row(&state.pool, "partner").await;
    let public = template_verification_key(state, &row).unwrap().unwrap();
    assert_eq!(public["crv"], "P-256");
    let jwt = sign_session_token(
        state,
        SessionTokenInput {
            session: &session,
            user: &user,
            user_json: &user_json,
            org: None,
            roles: vec![],
            role_permissions: vec![],
        },
        SessionTokenOptions {
            template: Some("partner"),
            azp: None,
        },
    )
    .await
    .unwrap();
    let key = Jwk::from_value(&public).unwrap();
    let payload = orbitid_credentials::verify_jws(
        &jwt,
        &JwkSet::new(vec![key]),
        &VerifyOptions {
            algorithms: vec![JwsAlgorithm::ES256],
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(payload["email"], "ada@example.com");
}

fn base64_url(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

#[tokio::test]
async fn the_session_org_claims_come_from_the_caller_resolution() {
    let context = test_state().await;
    let state = &context.state;
    let user = common::insert_user(&state.pool, "user_ada", "ada@example.com").await;
    let session_id = common::insert_session(&state.pool, "sess_ada", &user.id).await;
    let session = sqlx::query_as("SELECT * FROM sessions WHERE id = $1")
        .bind(&session_id)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    let user_json = common::user_json(&user);
    let org = TokenOrg {
        id: "org_acme".into(),
        slug: Some("acme".into()),
        name: "Acme".into(),
        role: "org:admin".into(),
        permissions: vec!["org:sys_memberships:read".into()],
    };
    let jwt = sign_session_token(
        state,
        SessionTokenInput {
            session: &session,
            user: &user,
            user_json: &user_json,
            org: Some(&org),
            roles: vec![],
            role_permissions: vec![],
        },
        SessionTokenOptions::default(),
    )
    .await
    .unwrap();
    let payload = orbitid_credentials::decode_jwt_payload(&jwt).unwrap();
    assert_eq!(payload["org_id"], "org_acme");
    assert_eq!(payload["org_slug"], "acme");
    assert_eq!(payload["org_role"], "org:admin");
    assert_eq!(
        payload["org_permissions"],
        json!(["org:sys_memberships:read"])
    );
    assert_eq!(payload["token_type"], "session");
    let _ = get_jwks(state).await.unwrap();
}
