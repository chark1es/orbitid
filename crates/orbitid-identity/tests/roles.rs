use orbitid_core::error::error_codes;
use orbitid_core::http::now;
use orbitid_identity::rbac::{
    assert_creator_eligible, assert_custom_key, assert_role_deletable, permissions::PROFILE_MANAGE,
    role_by_key, role_scope, serialize_role, system_role_key, SYSTEM_PERMISSIONS, SYSTEM_ROLES,
};
use orbitid_identity::testing::test_app_state;
use orbitid_identity::user_roles::{role_claims_for_user, roles_for_user, set_user_roles};

async fn seed_state() -> orbitid_identity::testing::TestApp {
    test_app_state().await
}

#[tokio::test]
async fn system_rbac_seed_is_idempotent() {
    let app = seed_state().await;
    let state = app.state();
    let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM roles")
        .fetch_one(&state.pool)
        .await
        .unwrap();
    let links: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM role_permissions")
        .fetch_one(&state.pool)
        .await
        .unwrap();
    orbitid_identity::orgs::seed_rbac(state).await.unwrap();
    orbitid_identity::orgs::seed_rbac(state).await.unwrap();
    let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM roles")
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(before, after);
    assert_eq!(
        links,
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM role_permissions")
            .fetch_one(&state.pool)
            .await
            .unwrap()
    );
    assert_eq!(SYSTEM_PERMISSIONS.len(), 6);
    assert_eq!(SYSTEM_ROLES.len(), 2);
    assert_eq!(
        orbitid_identity::rbac::permissions_for_role(state, "org:admin")
            .await
            .unwrap(),
        vec![
            "org:sys_domains:manage",
            "org:sys_domains:read",
            "org:sys_memberships:manage",
            "org:sys_memberships:read",
            "org:sys_profile:delete",
            "org:sys_profile:manage",
        ]
    );
    assert_eq!(
        orbitid_identity::rbac::permissions_for_role(state, "org:member")
            .await
            .unwrap(),
        vec!["org:sys_domains:read", "org:sys_memberships:read"]
    );
    let admin = role_by_key(state, "org:admin").await.unwrap().unwrap();
    assert!(admin.is_system);
    assert!(system_role_key("org:admin"));
    assert!(!system_role_key("app:support"));
    assert_eq!(role_scope("org:support"), "organization");
    assert_eq!(role_scope("app:support"), "instance");
    let json = serialize_role(state, &admin).await.unwrap();
    assert_eq!(json.scope, "organization");
    assert!(json.is_system);
    assert!(json.permissions.iter().any(|p| p.key == PROFILE_MANAGE));
}

async fn grant_role(state: &orbitid_core::AppState, key: &str, permission: &str) {
    let now_ms = now();
    sqlx::query(
        "INSERT INTO roles (id, key, name, description, is_creator_eligible, is_system, created_at, \
         updated_at) VALUES ($1, $2, $2, '', false, false, $3, $3) ON CONFLICT DO NOTHING",
    )
    .bind(format!("role_{key}"))
    .bind(key)
    .bind(now_ms)
    .execute(&state.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO permissions (id, key, name, description, type, created_at, updated_at) \
         VALUES ($1, $2, $2, '', 'user', $3, $3) ON CONFLICT DO NOTHING",
    )
    .bind(format!("perm_{permission}"))
    .bind(permission)
    .bind(now_ms)
    .execute(&state.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING")
        .bind(format!("role_{key}"))
        .bind(format!("perm_{permission}"))
        .execute(&state.pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn role_claims_are_sorted_and_drop_non_instance_roles() {
    let app = seed_state().await;
    let state = app.state();
    let user =
        orbitid_identity::testing::create_test_user(state, "roles@example.com", "Sup3r-secret!")
            .await
            .unwrap();
    grant_role(state, "app:analyst", "app:batch:0").await;
    grant_role(state, "app:auditor", "app:batch:1").await;
    grant_role(state, "app:support", "app:batch:2").await;
    set_user_roles(
        state,
        &user.user.id,
        &[
            "app:support".into(),
            "app:analyst".into(),
            "app:auditor".into(),
        ],
    )
    .await
    .unwrap();
    // A non-instance key must not leak into instance claims.
    sqlx::query(
        "INSERT INTO user_roles (user_id, role_key, created_at, updated_at) VALUES ($1, 'org:admin', $2, $2)",
    )
    .bind(&user.user.id)
    .bind(now())
    .execute(&state.pool)
    .await
    .unwrap();
    let claims = role_claims_for_user(state, &user.user.id).await.unwrap();
    assert_eq!(
        claims.roles,
        vec!["app:analyst", "app:auditor", "app:support"]
    );
    assert_eq!(
        claims.permissions,
        vec!["app:batch:0", "app:batch:1", "app:batch:2"]
    );
    // `rolesForUser` returns every assignment row (the TS contract);
    // `role_claims_for_user` is the one that filters to instance roles.
    assert_eq!(
        roles_for_user(state, &user.user.id).await.unwrap(),
        vec!["app:analyst", "app:auditor", "app:support", "org:admin"]
    );

    // A deleted role's assignment disappears with it and is never revived by
    // creating a new row with the same key.
    grant_role(state, "app:temp", "app:temp:read").await;
    set_user_roles(
        state,
        &user.user.id,
        &["app:analyst".into(), "app:temp".into()],
    )
    .await
    .unwrap();
    sqlx::query("DELETE FROM roles WHERE key = 'app:temp'")
        .execute(&state.pool)
        .await
        .unwrap();
    grant_role(state, "app:temp", "app:temp:read").await;
    let claims = role_claims_for_user(state, &user.user.id).await.unwrap();
    assert_eq!(claims.roles, vec!["app:analyst"]);
    assert_eq!(claims.permissions, vec!["app:batch:0"]);
}

#[tokio::test]
async fn set_user_roles_rejects_unknown_and_org_roles_without_clearing() {
    let app = seed_state().await;
    let state = app.state();
    let user =
        orbitid_identity::testing::create_test_user(state, "reject@example.com", "Sup3r-secret!")
            .await
            .unwrap();
    grant_role(state, "app:support", "app:reports:read").await;
    set_user_roles(state, &user.user.id, &["app:support".into()])
        .await
        .unwrap();

    let error = set_user_roles(state, &user.user.id, &["org:admin".into()])
        .await
        .unwrap_err();
    assert_eq!(error.code, error_codes::FORM_PARAM_VALUE_INVALID);
    let error = set_user_roles(state, &user.user.id, &["app:missing".into()])
        .await
        .unwrap_err();
    assert_eq!(error.code, error_codes::ORG_ROLE_NOT_FOUND);
    assert_eq!(
        roles_for_user(state, &user.user.id).await.unwrap(),
        vec!["app:support"]
    );
}

#[tokio::test]
async fn concurrent_role_replacements_never_merge() {
    let app = seed_state().await;
    let state = app.state();
    let user =
        orbitid_identity::testing::create_test_user(state, "atomic@example.com", "Sup3r-secret!")
            .await
            .unwrap();
    grant_role(state, "app:reader", "app:records:read").await;
    grant_role(state, "app:writer", "app:records:write").await;
    let a = state.clone();
    let b = state.clone();
    let user_a = user.user.id.clone();
    let user_b = user.user.id.clone();
    let first =
        tokio::spawn(async move { set_user_roles(&a, &user_a, &["app:reader".into()]).await });
    let second =
        tokio::spawn(async move { set_user_roles(&b, &user_b, &["app:writer".into()]).await });
    first.await.unwrap().unwrap();
    second.await.unwrap().unwrap();
    let roles = roles_for_user(state, &user.user.id).await.unwrap();
    assert!(
        roles == vec!["app:reader".to_string()] || roles == vec!["app:writer".to_string()],
        "merged grants: {roles:?}"
    );
}

#[tokio::test]
async fn failed_insert_rolls_back_the_previous_assignment() {
    let app = seed_state().await;
    let state = app.state();
    let user =
        orbitid_identity::testing::create_test_user(state, "rollback@example.com", "Sup3r-secret!")
            .await
            .unwrap();
    grant_role(state, "app:reader", "app:records:read").await;
    grant_role(state, "app:writer", "app:records:write").await;
    set_user_roles(state, &user.user.id, &["app:reader".into()])
        .await
        .unwrap();
    sqlx::query(
        "CREATE FUNCTION refuse_grant_insert() RETURNS trigger AS $$ \
         BEGIN RAISE EXCEPTION 'injected insert failure'; END; $$ LANGUAGE plpgsql",
    )
    .execute(&state.pool)
    .await
    .unwrap();
    sqlx::query(
        "CREATE TRIGGER refuse_grant_insert BEFORE INSERT ON user_roles \
         FOR EACH ROW EXECUTE FUNCTION refuse_grant_insert()",
    )
    .execute(&state.pool)
    .await
    .unwrap();
    assert!(set_user_roles(state, &user.user.id, &["app:writer".into()])
        .await
        .is_err());
    assert_eq!(
        roles_for_user(state, &user.user.id).await.unwrap(),
        vec!["app:reader"]
    );
}

#[tokio::test]
async fn custom_key_syntax_matches_the_ts_validator() {
    for key in [
        "org:team-lead",
        "app:support-2",
        "org:support_2",
        "org:billing",
        "app:a1",
        "org:billing:read",
    ] {
        assert!(assert_custom_key(key, "role").is_ok(), "{key}");
    }
    for key in [
        "support",
        "org:sys_x",
        "app:sys_x",
        "org:",
        "APP:BAD",
        "org:space name",
        "org:Support",
        "org:x::y",
        "org:-leading",
    ] {
        assert!(assert_custom_key(key, "role").is_err(), "{key}");
    }
    assert!(assert_creator_eligible("app:support", true).is_err());
    assert!(assert_creator_eligible("org:owner", true).is_ok());
}

#[tokio::test]
async fn role_deletion_is_guarded() {
    let app = seed_state().await;
    let state = app.state();
    let user = orbitid_identity::testing::create_test_user(
        state,
        "delete-role@example.com",
        "Sup3r-secret!",
    )
    .await
    .unwrap();
    grant_role(state, "app:support", "app:reports:read").await;
    let role = role_by_key(state, "app:support").await.unwrap().unwrap();
    assert_role_deletable(state, &role).await.unwrap();
    set_user_roles(state, &user.user.id, &["app:support".into()])
        .await
        .unwrap();
    let error = assert_role_deletable(state, &role).await.unwrap_err();
    assert_eq!(error.code, error_codes::NOT_ALLOWED_ACCESS);
    set_user_roles(state, &user.user.id, &[]).await.unwrap();
    assert_role_deletable(state, &role).await.unwrap();
    let admin = role_by_key(state, "org:admin").await.unwrap().unwrap();
    assert!(assert_role_deletable(state, &admin).await.is_err());
}

#[tokio::test]
async fn role_permission_replacement_is_atomic() {
    let app = seed_state().await;
    let state = app.state();
    grant_role(state, "org:viewer", "org:notes:read").await;
    let role = role_by_key(state, "org:viewer").await.unwrap().unwrap();
    orbitid_identity::rbac::set_role_permissions(state, &role, &["org:notes:read".to_string()])
        .await
        .unwrap();
    assert_eq!(
        orbitid_identity::rbac::permissions_for_role_id(state, &role.id)
            .await
            .unwrap(),
        vec!["org:notes:read"]
    );
    // Mixing scopes is rejected before any write.
    let mixed = orbitid_identity::rbac::set_role_permissions(
        state,
        &role,
        &["app:reports:read".to_string()],
    )
    .await
    .unwrap_err();
    assert_eq!(mixed.code, error_codes::FORM_PARAM_VALUE_INVALID);
    assert_eq!(
        orbitid_identity::rbac::permissions_for_role_id(state, &role.id)
            .await
            .unwrap(),
        vec!["org:notes:read"]
    );
}
