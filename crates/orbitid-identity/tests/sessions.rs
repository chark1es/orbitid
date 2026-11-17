use orbitid_core::error::error_codes;
use orbitid_core::http::now;
use orbitid_core::keys::SESSION_NEVER_EXPIRES_AT;
use orbitid_identity::sessions::{
    create_session, end_session, evaluate_session_status, get_session, is_session_expired,
    session_expire_at, session_expires_at, slide_session_activity, touch_session,
    CreateSessionInput, TouchSessionOptions,
};
use orbitid_identity::testing::{
    create_test_client_session, create_test_organization, create_test_user, test_app_state,
};
use orbitid_identity::tokens::{sign_session_token, verify_session_token};

#[tokio::test]
async fn defaults_have_no_maximum_lifetime() {
    let app = test_app_state().await;
    let state = app.state();
    let user = create_test_user(state, "defaults@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let auth = create_test_client_session(state, &user.user.id)
        .await
        .unwrap();
    let stored = get_session(state, &auth.session.id).await.unwrap().unwrap();
    assert_eq!(stored.expire_at, SESSION_NEVER_EXPIRES_AT);
    assert_eq!(session_expires_at(state, &stored), i64::MAX);
    assert!(!is_session_expired(state, &stored));

    assert_eq!(session_expire_at(1_000, 0, None), SESSION_NEVER_EXPIRES_AT);
    assert_eq!(session_expire_at(1_000, 3_600, None), 1_000 + 3_600_000);
    assert_eq!(session_expire_at(1_000, 0, Some(60)), 1_000 + 60_000);
    assert_eq!(session_expire_at(1_000, 60, Some(30)), 1_000 + 30_000);
}

#[tokio::test]
async fn explicit_cap_is_enforced_under_unlimited_policy() {
    let app = test_app_state().await;
    let state = app.state();
    let user = create_test_user(state, "cap@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let auth = create_test_client_session(state, &user.user.id)
        .await
        .unwrap();
    sqlx::query("UPDATE sessions SET expire_at = $1 WHERE id = $2")
        .bind(now() - 1)
        .bind(&auth.session.id)
        .execute(&state.pool)
        .await
        .unwrap();
    let stored = get_session(state, &auth.session.id).await.unwrap().unwrap();
    assert!(is_session_expired(state, &stored));
    assert_eq!(
        evaluate_session_status(state, &stored).await.unwrap(),
        "expired"
    );
}

#[tokio::test]
async fn instance_lifetime_caps_the_sentinel_from_created_at() {
    let app = test_app_state().await;
    let state = app.state();
    let user = create_test_user(state, "lifetime@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let auth = create_test_client_session(state, &user.user.id)
        .await
        .unwrap();
    state
        .settings
        .update(serde_json::json!({ "session": { "lifetimeSeconds": 3600 } }))
        .await
        .unwrap();
    let stored = get_session(state, &auth.session.id).await.unwrap().unwrap();
    assert_eq!(
        session_expires_at(state, &stored),
        stored.created_at + 3_600_000
    );
}

#[tokio::test]
async fn stale_expiry_read_never_overwrites_a_revocation() {
    let app = test_app_state().await;
    let state = app.state();
    let user = create_test_user(state, "revoked@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let auth = create_test_client_session(state, &user.user.id)
        .await
        .unwrap();
    let stale = auth.session.clone();
    sqlx::query("UPDATE sessions SET status = 'revoked', updated_at = $1 WHERE id = $2")
        .bind(now())
        .bind(&auth.session.id)
        .execute(&state.pool)
        .await
        .unwrap();
    let mut expired_copy = stale;
    expired_copy.expire_at = now() - 1;
    assert_eq!(
        evaluate_session_status(state, &expired_copy).await.unwrap(),
        "expired"
    );
    let stored = get_session(state, &auth.session.id).await.unwrap().unwrap();
    assert_eq!(stored.status, "revoked");
}

#[tokio::test]
async fn single_session_mode_ends_the_clients_other_sessions() {
    let app = test_app_state().await;
    let state = app.state();
    state
        .settings
        .update(serde_json::json!({ "session": { "multiSession": false } }))
        .await
        .unwrap();
    let user = create_test_user(state, "single@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let auth = create_test_client_session(state, &user.user.id)
        .await
        .unwrap();
    let created = create_session(
        state,
        CreateSessionInput::new(auth.client.id.clone(), user.user.id.clone()),
    )
    .await
    .unwrap();
    let first = get_session(state, &auth.session.id).await.unwrap().unwrap();
    assert_eq!(first.status, "ended");
    let second = get_session(state, &created.id).await.unwrap().unwrap();
    assert_eq!(second.status, "active");
    let client =
        sqlx::query_as::<_, orbitid_core::models::ClientRow>("SELECT * FROM clients WHERE id = $1")
            .bind(&auth.client.id)
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert_eq!(
        client.last_active_session_id.as_deref(),
        Some(created.id.as_str())
    );

    let ended = end_session(state, &second, "ended").await.unwrap();
    assert_eq!(ended.status, "ended");
    let client =
        sqlx::query_as::<_, orbitid_core::models::ClientRow>("SELECT * FROM clients WHERE id = $1")
            .bind(&auth.client.id)
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert!(client.last_active_session_id.is_none());
}

#[tokio::test]
async fn inactivity_is_enforced_and_slides_on_refresh() {
    let app = test_app_state().await;
    let state = app.state();
    state
        .settings
        .update(serde_json::json!({ "session": { "inactivityTimeoutSeconds": 60 } }))
        .await
        .unwrap();
    let user = create_test_user(state, "idle@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let auth = create_test_client_session(state, &user.user.id)
        .await
        .unwrap();
    sqlx::query("UPDATE sessions SET last_active_at = $1 WHERE id = $2")
        .bind(now() - 120_000)
        .bind(&auth.session.id)
        .execute(&state.pool)
        .await
        .unwrap();
    let stale = get_session(state, &auth.session.id).await.unwrap().unwrap();
    assert!(is_session_expired(state, &stale));

    let slid = slide_session_activity(state, &stale, None).await.unwrap();
    assert!(slid.last_active_at > now() - 5_000);
    assert!(!is_session_expired(state, &slid));
}

#[tokio::test]
async fn token_refresh_counts_as_user_activity() {
    let app = test_app_state().await;
    let state = app.state();
    let user = create_test_user(state, "active@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let auth = create_test_client_session(state, &user.user.id)
        .await
        .unwrap();
    sqlx::query("UPDATE users SET last_active_at = $1 WHERE id = $2")
        .bind(now() - 10 * 86_400_000)
        .bind(&user.user.id)
        .execute(&state.pool)
        .await
        .unwrap();
    let stored = get_session(state, &auth.session.id).await.unwrap().unwrap();
    slide_session_activity(state, &stored, None).await.unwrap();
    let refreshed = orbitid_identity::users::require_user(state, &user.user.id)
        .await
        .unwrap();
    assert!(refreshed.last_active_at.unwrap() > now() - 5_000);
}

#[tokio::test]
async fn minted_token_carries_org_and_instance_role_claims() {
    let app = test_app_state().await;
    let state = app.state();
    state
        .settings
        .update(serde_json::json!({ "organizations": { "enabled": true } }))
        .await
        .unwrap();
    let user = create_test_user(state, "claims@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let auth = create_test_client_session(state, &user.user.id)
        .await
        .unwrap();
    let org = create_test_organization(state, "Claims Inc", Some("claims-inc"), &user.user.id)
        .await
        .unwrap();

    let now_ms = now();
    sqlx::query("INSERT INTO roles (id, key, name, description, is_system, created_at, updated_at) VALUES ('role_support', 'app:support', 'Support', '', false, $1, $1)")
        .bind(now_ms)
        .execute(&state.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO permissions (id, key, name, description, type, created_at, updated_at) VALUES ('perm_read', 'app:reports:read', 'Read', '', 'user', $1, $1)")
        .bind(now_ms)
        .execute(&state.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO role_permissions (role_id, permission_id) VALUES ('role_support', 'perm_read')")
        .execute(&state.pool)
        .await
        .unwrap();
    orbitid_identity::user_roles::set_user_roles(
        state,
        &user.user.id,
        &["app:support".to_string()],
    )
    .await
    .unwrap();
    let session = touch_session(
        state,
        &auth.session,
        TouchSessionOptions {
            organization_id: Some(Some(org.id.clone())),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let jwt = sign_session_token(
        state,
        &session.id,
        orbitid_identity::tokens::SignSessionTokenOptions::default(),
    )
    .await
    .unwrap();
    let claims = verify_session_token(state, &jwt, None).await.unwrap();
    assert_eq!(claims.sid, session.id);
    assert_eq!(claims.org_id.as_deref(), Some(org.id.as_str()));
    assert_eq!(claims.org_slug.as_deref(), Some("claims-inc"));
    assert_eq!(claims.org_role.as_deref(), Some("org:admin"));
    assert!(claims
        .org_permissions
        .as_ref()
        .unwrap()
        .contains(&"org:sys_profile:manage".to_string()));
    assert_eq!(
        claims.roles.as_deref(),
        Some(&["app:support".to_string()][..])
    );
    assert_eq!(
        claims.role_permissions.as_deref(),
        Some(&["app:reports:read".to_string()][..])
    );
}

#[tokio::test]
async fn ended_session_token_cannot_be_minted() {
    let app = test_app_state().await;
    let state = app.state();
    let user = create_test_user(state, "ended@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let auth = create_test_client_session(state, &user.user.id)
        .await
        .unwrap();
    let row = get_session(state, &auth.session.id).await.unwrap().unwrap();
    end_session(state, &row, "ended").await.unwrap();
    let error = sign_session_token(
        state,
        &auth.session.id,
        orbitid_identity::tokens::SignSessionTokenOptions::default(),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, error_codes::AUTHENTICATION_INVALID);
}

/// Ending a session must be atomic with grant revocation and the event row.
/// Before the fix the status UPDATE committed on the pool; a failure while
/// revoking grants left an ended session with live OAuth grants and no event.
#[tokio::test]
async fn end_session_rolls_back_when_grant_revocation_fails() {
    let app = test_app_state().await;
    let state = app.state();
    let user = create_test_user(state, "atomic-end@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let auth = create_test_client_session(state, &user.user.id)
        .await
        .unwrap();
    insert_grant_with_session(state, &user.user.id, &auth.session.id).await;
    fail_oauth_grant_updates(state).await;

    let stored = get_session(state, &auth.session.id).await.unwrap().unwrap();
    let failed = end_session(state, &stored, "ended").await;
    assert!(failed.is_err(), "the injected grant failure must propagate");

    let after = get_session(state, &auth.session.id).await.unwrap().unwrap();
    assert_eq!(
        after.status, "active",
        "the status change must roll back with the grant revocation"
    );
    let revoked: bool = sqlx::query_scalar("SELECT revoked FROM oauth_grants")
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert!(!revoked);
    let events: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM webhook_events WHERE type = 'session.ended'")
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert_eq!(events, 0, "a rolled-back sign-out must leave no event row");
}

/// The bulk sign-out path has the same atomicity requirement.
#[tokio::test]
async fn end_sessions_for_user_rolls_back_when_grant_revocation_fails() {
    let app = test_app_state().await;
    let state = app.state();
    let user = create_test_user(state, "atomic-end-all@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let auth = create_test_client_session(state, &user.user.id)
        .await
        .unwrap();
    insert_grant_with_session(state, &user.user.id, &auth.session.id).await;
    fail_oauth_grant_updates(state).await;

    let failed =
        orbitid_identity::sessions::end_sessions_for_user(state, &user.user.id, "revoked", None)
            .await;
    assert!(failed.is_err());
    let after = get_session(state, &auth.session.id).await.unwrap().unwrap();
    assert_eq!(after.status, "active");
    let revoked: bool = sqlx::query_scalar("SELECT revoked FROM oauth_grants")
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert!(!revoked);
    let events: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM webhook_events WHERE type = 'session.revoked'")
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert_eq!(events, 0);
}

async fn insert_grant_with_session(
    state: &orbitid_core::AppState,
    user_id: &str,
    session_id: &str,
) {
    let now = now();
    sqlx::query(
        "INSERT INTO oauth_applications (id, name, client_id, redirect_uris, created_at, updated_at) \
         VALUES ('app_atomic', 'Atomic', 'client_atomic', '[]'::jsonb, $1, $1)",
    )
    .bind(now)
    .execute(&state.pool)
    .await
    .expect("application");
    sqlx::query(
        "INSERT INTO oauth_grants \
         (id, kind, application_id, user_id, token_hash, scopes, expires_at, created_at, session_id) \
         VALUES ('grant_atomic', 'refresh', 'app_atomic', $1, 'hash_atomic', 'openid', $2, $2, $3)",
    )
    .bind(user_id)
    .bind(now + 3_600_000)
    .bind(session_id)
    .execute(&state.pool)
    .await
    .expect("grant");
}

async fn fail_oauth_grant_updates(state: &orbitid_core::AppState) {
    sqlx::query(
        "CREATE OR REPLACE FUNCTION orbitid_test_fail_grant_update() RETURNS trigger AS $$ \
         BEGIN RAISE EXCEPTION 'injected grant revocation failure'; END; $$ LANGUAGE plpgsql",
    )
    .execute(&state.pool)
    .await
    .expect("function");
    sqlx::query(
        "CREATE TRIGGER orbitid_test_fail_grant_update BEFORE UPDATE ON oauth_grants \
         FOR EACH ROW EXECUTE FUNCTION orbitid_test_fail_grant_update()",
    )
    .execute(&state.pool)
    .await
    .expect("trigger");
}

/// Single-session mode under concurrency: eight simultaneous session creations
/// on one client must leave exactly one active session. Before the client-row
/// lock every task read the same "no other active session" snapshot and all
/// eight won.
#[tokio::test]
async fn concurrent_single_session_creations_leave_exactly_one_active_session() {
    let app = test_app_state().await;
    let state = app.state();
    state
        .settings
        .update(serde_json::json!({ "session": { "multiSession": false } }))
        .await
        .unwrap();
    let user = create_test_user(state, "single-race@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let auth = create_test_client_session(state, &user.user.id)
        .await
        .unwrap();
    let client_id = auth.client.id.clone();
    let user_id = user.user.id.clone();

    for round in 0..3 {
        let mut tasks = tokio::task::JoinSet::new();
        for _ in 0..8 {
            let state = state.clone();
            let client_id = client_id.clone();
            let user_id = user_id.clone();
            tasks.spawn(async move {
                create_session(&state, CreateSessionInput::new(client_id, user_id)).await
            });
        }
        while let Some(result) = tasks.join_next().await {
            result.unwrap().unwrap();
        }
        let active: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sessions WHERE client_id = $1 AND status = 'active'",
        )
        .bind(&client_id)
        .fetch_one(&state.pool)
        .await
        .unwrap();
        assert_eq!(active, 1, "round {round}");
    }
}
