//! Regression tests for the multi-replica hardening work: concurrent RBAC
//! seeding, TOTP replay protection, retention sweeps and the client bootstrap
//! race.

use orbitid_core::http::now;
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::testing::test_state;
use orbitid_credentials::mfa::{totp_code_at, verify_totp_once};
use orbitid_identity::client_auth::get_or_create_client;
use orbitid_identity::orgs::seed_rbac;
use orbitid_identity::rbac::{SYSTEM_PERMISSIONS, SYSTEM_ROLES};
use orbitid_identity::retention::{sweep_once, CLIENT_ORPHAN_GRACE_MS, RETENTION_GRACE_MS};
use orbitid_identity::testing::{
    create_test_client_session, create_test_user, enable_totp, test_app_state,
};
use std::sync::Arc;

#[tokio::test]
async fn concurrent_rbac_seed_converges_on_one_set() {
    // A fresh migrated database with no seed, like three replicas booting.
    let context = test_state().await;
    let state = Arc::new(context.state.clone());
    let mut tasks = Vec::new();
    for _ in 0..12 {
        let state = state.clone();
        tasks.push(tokio::spawn(async move { seed_rbac(&state).await }));
    }
    for task in tasks {
        task.await.unwrap().expect("seed_rbac must not race");
    }
    let permissions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM permissions")
        .fetch_one(&state.pool)
        .await
        .unwrap();
    let roles: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM roles")
        .fetch_one(&state.pool)
        .await
        .unwrap();
    let links: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM role_permissions")
        .fetch_one(&state.pool)
        .await
        .unwrap();
    let expected_links: i64 = SYSTEM_ROLES
        .iter()
        .map(|role| role.permissions.len() as i64)
        .sum();
    assert_eq!(permissions, SYSTEM_PERMISSIONS.len() as i64);
    assert_eq!(roles, SYSTEM_ROLES.len() as i64);
    assert_eq!(links, expected_links);
}

#[tokio::test]
async fn a_totp_code_cannot_be_replayed() {
    let app = test_app_state().await;
    let state = app.state();
    let user = create_test_user(state, "replay@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let secret = enable_totp(state, &user.user.id).await.unwrap();
    let user = orbitid_identity::users::require_user(state, &user.user.id)
        .await
        .unwrap();
    let code = totp_code_at(&secret, now() / 1000).expect("totp code");

    assert!(verify_totp_once(state, &user, &code).await.unwrap());
    assert!(
        !verify_totp_once(state, &user, &code).await.unwrap(),
        "the same code must be rejected the second time"
    );
    let next = totp_code_at(&secret, now() / 1000 + 30).expect("next code");
    assert!(
        verify_totp_once(state, &user, &next).await.unwrap(),
        "the next step's code must still work"
    );
}

#[tokio::test]
async fn concurrent_totp_attempts_accept_exactly_one() {
    let app = test_app_state().await;
    let state = app.state();
    let user = create_test_user(state, "replay-race@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let secret = enable_totp(state, &user.user.id).await.unwrap();
    let user = orbitid_identity::users::require_user(state, &user.user.id)
        .await
        .unwrap();
    let code = totp_code_at(&secret, now() / 1000).expect("totp code");
    let (left, right) = tokio::join!(
        verify_totp_once(state, &user, &code),
        verify_totp_once(state, &user, &code),
    );
    let accepted = [left.unwrap(), right.unwrap()]
        .into_iter()
        .filter(|ok| *ok)
        .count();
    assert_eq!(accepted, 1);
}

#[tokio::test]
async fn retention_deletes_only_dead_rows() {
    let app = test_app_state().await;
    let state = app.state();
    let user = create_test_user(state, "retention@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let now_ms = now();
    let old = now_ms - RETENTION_GRACE_MS - 60_000;
    let live = now_ms + 24 * 60 * 60 * 1000;

    sqlx::query(
        "INSERT INTO verifications (id, purpose, strategy, identifier, owner_id, attempts, \
         max_attempts, expires_at, created_at) VALUES ($1,'sign_in','email_code',$2,$3,0,5,$4,$4)",
    )
    .bind(new_id(id_prefix::VERIFICATION))
    .bind("dead@example.com")
    .bind(&user.user.id)
    .bind(old)
    .execute(&state.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO verifications (id, purpose, strategy, identifier, owner_id, attempts, \
         max_attempts, expires_at, created_at) VALUES ($1,'sign_in','email_code',$2,$3,0,5,$4,$5)",
    )
    .bind(new_id(id_prefix::VERIFICATION))
    .bind("live@example.com")
    .bind(&user.user.id)
    .bind(live)
    .bind(now_ms)
    .execute(&state.pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO oauth_applications (id, name, client_id, redirect_uris, created_at, updated_at) \
         VALUES ('oa_retention','App','client_retention','[]'::jsonb,$1,$1)",
    )
    .bind(now_ms)
    .execute(&state.pool)
    .await
    .unwrap();
    for (id, family, expires) in [
        ("grant_dead", "family_dead", old),
        ("grant_old_family_live", "family_live", old),
        ("grant_family_live", "family_live", live),
    ] {
        sqlx::query(
            "INSERT INTO oauth_grants (id, kind, application_id, user_id, token_hash, scopes, \
             family_id, revoked, expires_at, created_at) \
             VALUES ($1,'refresh','oa_retention',$2,$3,'openid',$4,true,$5,$6)",
        )
        .bind(id)
        .bind(&user.user.id)
        .bind(format!("hash_{id}"))
        .bind(family)
        .bind(expires)
        .bind(now_ms)
        .execute(&state.pool)
        .await
        .unwrap();
    }

    let auth = create_test_client_session(state, &user.user.id)
        .await
        .unwrap();
    for (id, session_id) in [
        ("si_dead", None),
        ("si_live", Some(auth.session.id.as_str())),
    ] {
        sqlx::query(
            "INSERT INTO sign_ins (id, client_id, status, state, created_session_id, abandon_at, \
             created_at, updated_at) VALUES ($1,$2,'needs_identifier','{}'::jsonb,$3,$4,$4,$4)",
        )
        .bind(id)
        .bind(&auth.client.id)
        .bind(session_id)
        .bind(old)
        .execute(&state.pool)
        .await
        .unwrap();
    }
    for (id, session_id) in [
        ("su_dead", None),
        ("su_live", Some(auth.session.id.as_str())),
    ] {
        sqlx::query(
            "INSERT INTO sign_ups (id, client_id, status, fields, unsafe_metadata, verifications, \
             created_session_id, abandon_at, created_at, updated_at) \
             VALUES ($1,$2,'missing_requirements','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,$3,$4,$4,$4)",
        )
        .bind(id)
        .bind(&auth.client.id)
        .bind(session_id)
        .bind(old)
        .execute(&state.pool)
        .await
        .unwrap();
    }

    let sweep = sweep_once(state, Some(now_ms), None).await.unwrap();
    assert_eq!(sweep.verifications, 1);
    assert_eq!(sweep.oauth_grants, 1, "only the dead family is removed");
    assert_eq!(sweep.sign_ins, 1);
    assert_eq!(sweep.sign_ups, 1);

    let remaining_grants: Vec<String> =
        sqlx::query_scalar("SELECT id FROM oauth_grants ORDER BY id")
            .fetch_all(&state.pool)
            .await
            .unwrap();
    assert_eq!(
        remaining_grants,
        vec![
            "grant_family_live".to_string(),
            "grant_old_family_live".to_string()
        ]
    );
    let sign_in: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sign_ins WHERE id = 'si_live'")
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(sign_in, 1);
}

#[tokio::test]
async fn unknown_client_cookie_is_never_adopted_as_a_credential() {
    let app = test_app_state().await;
    let state = app.state();
    let planted = orbitid_core::crypto::random_token(32);
    let mut headers = axum::http::HeaderMap::new();
    headers.insert(
        axum::http::header::COOKIE,
        axum::http::HeaderValue::from_str(&format!("__client={planted}")).unwrap(),
    );
    let (client, cookie) = get_or_create_client(state, &headers, "GET", "/v1/client")
        .await
        .unwrap();
    let cookie = cookie.expect("the SDK bootstrap mints a replacement cookie");
    let minted = cookie
        .split(';')
        .next()
        .and_then(|pair| pair.split_once('='))
        .map(|(_, value)| value.to_string())
        .expect("Set-Cookie carries a value");
    assert_ne!(minted, planted, "the presented value must not be reused");
    assert!(!cookie.contains(&planted));

    // The planted value never authenticates, and no row stores its hash.
    let mut planted_headers = axum::http::HeaderMap::new();
    planted_headers.insert(
        axum::http::header::COOKIE,
        axum::http::HeaderValue::from_str(&format!("__client={planted}")).unwrap(),
    );
    assert!(
        orbitid_identity::client_auth::find_client(state, &planted_headers)
            .await
            .unwrap()
            .is_none()
    );
    let planted_rows: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM clients WHERE token_hash = $1")
            .bind(orbitid_core::crypto::sha256(&planted))
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert_eq!(planted_rows, 0);

    // The freshly minted value does authenticate as the row we created.
    let mut minted_headers = axum::http::HeaderMap::new();
    minted_headers.insert(
        axum::http::header::COOKIE,
        axum::http::HeaderValue::from_str(&format!("__client={minted}")).unwrap(),
    );
    assert_eq!(
        orbitid_identity::client_auth::find_client(state, &minted_headers)
            .await
            .unwrap()
            .expect("minted token authenticates")
            .id,
        client.id
    );
}

#[tokio::test]
async fn retention_sweeps_orphan_clients_but_keeps_signed_in_browsers() {
    let app = test_app_state().await;
    let state = app.state();
    let user = create_test_user(state, "keep@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let (orphan, _) = orbitid_identity::client_auth::create_client(state, None, None)
        .await
        .unwrap();
    let live = create_test_client_session(state, &user.user.id)
        .await
        .unwrap();
    let at = now() + CLIENT_ORPHAN_GRACE_MS + 60_000;
    for client in [&orphan, &live.client] {
        sqlx::query("UPDATE clients SET updated_at = $1 WHERE id = $2")
            .bind(now() - CLIENT_ORPHAN_GRACE_MS - 60_000)
            .bind(&client.id)
            .execute(&state.pool)
            .await
            .unwrap();
    }
    let sweep = sweep_once(state, Some(at), None).await.unwrap();
    assert_eq!(sweep.clients, 1);
    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM clients WHERE id = $1")
        .bind(&live.client.id)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(remaining, 1);
    let gone: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM clients WHERE id = $1")
        .bind(&orphan.id)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(gone, 0);
}
