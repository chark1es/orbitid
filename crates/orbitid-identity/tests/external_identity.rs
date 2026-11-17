use orbitid_core::error::error_codes;
use orbitid_core::http::now;
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_identity::enterprise_access::{
    assert_additional_identifications_allowed, enterprise_connection_for_user,
    enterprise_connection_id_from_provider, sync_enterprise_user_attributes,
};
use orbitid_identity::external_identity::{
    link_external_account, profile_email_may_link, ExternalProfile,
};
use orbitid_identity::testing::{create_test_user, test_app_state};

fn profile(provider: &str, uid: &str, email: &str) -> ExternalProfile {
    ExternalProfile {
        provider: provider.into(),
        provider_user_id: uid.into(),
        email: Some(email.into()),
        email_verified: Some(true),
        first_name: Some("Grace".into()),
        last_name: Some("Hopper".into()),
        image_url: Some("https://example.com/avatar.png".into()),
        access_token: Some("access-token".into()),
        scopes: Some("openid email profile".into()),
        ..Default::default()
    }
}

async fn insert_connection(
    state: &orbitid_core::AppState,
    id: &str,
    provider: &str,
    disable_additional: bool,
    sync_attributes: bool,
) {
    let now_ms = now();
    sqlx::query(
        "INSERT INTO enterprise_connections (id, name, protocol, provider, domains, active, \
         allow_subdomains, allow_idp_initiated, sync_user_attributes, \
         disable_additional_identifications, config, created_at, updated_at) \
         VALUES ($1, $2, 'oidc', $3, '[]', true, false, false, $4, $5, '{}', $6, $6)",
    )
    .bind(id)
    .bind(format!("Connection {id}"))
    .bind(provider)
    .bind(sync_attributes)
    .bind(disable_additional)
    .bind(now_ms)
    .execute(&state.pool)
    .await
    .unwrap();
}

#[test]
fn only_provider_verified_email_may_link() {
    assert!(profile_email_may_link(&ExternalProfile {
        email: Some("a@b.co".into()),
        email_verified: Some(true),
        ..Default::default()
    }));
    assert!(!profile_email_may_link(&ExternalProfile {
        email: Some("a@b.co".into()),
        email_verified: Some(false),
        ..Default::default()
    }));
    assert!(!profile_email_may_link(&ExternalProfile {
        email: Some("a@b.co".into()),
        email_verified: None,
        ..Default::default()
    }));
    assert!(!profile_email_may_link(&ExternalProfile {
        email: None,
        email_verified: Some(true),
        ..Default::default()
    }));
}

#[test]
fn enterprise_provider_prefixes_are_stripped() {
    assert_eq!(
        enterprise_connection_id_from_provider("saml_ent_123").as_deref(),
        Some("ent_123")
    );
    assert_eq!(
        enterprise_connection_id_from_provider("oidc_ent_123").as_deref(),
        Some("ent_123")
    );
    assert_eq!(
        enterprise_connection_id_from_provider("enterprise_saml_ent_1").as_deref(),
        Some("ent_1")
    );
    assert!(enterprise_connection_id_from_provider("google").is_none());
}

#[tokio::test]
async fn linking_an_account_stores_encrypted_tokens_and_refreshes_it() {
    let app = test_app_state().await;
    let state = app.state();
    let user = create_test_user(state, "link@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let linked = link_external_account(
        state,
        &user.user.id,
        &profile("google", "g-1", "link@example.com"),
    )
    .await
    .unwrap();
    assert_eq!(linked.user_id.as_deref(), Some(user.user.id.as_str()));
    assert_eq!(linked.provider, "google");
    assert!(linked.access_token_enc.is_some());
    assert!(!linked
        .access_token_enc
        .as_deref()
        .unwrap()
        .contains("access-token"));
    let decrypted = orbitid_core::crypto::decrypt(
        &state.env.encryption_key,
        linked.access_token_enc.as_deref().unwrap(),
    )
    .unwrap();
    assert_eq!(decrypted, "access-token");

    let refreshed = link_external_account(
        state,
        &user.user.id,
        &ExternalProfile {
            email: Some("new@example.com".into()),
            first_name: None,
            ..profile("google", "g-1", "link@example.com")
        },
    )
    .await
    .unwrap();
    assert_eq!(refreshed.id, linked.id);
    assert_eq!(refreshed.email_address, "new@example.com");
    assert_eq!(refreshed.first_name, "Grace");

    let other = create_test_user(state, "other-link@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let error = link_external_account(
        state,
        &other.user.id,
        &profile("google", "g-1", "link@example.com"),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, error_codes::EXTERNAL_ACCOUNT_EXISTS);
}

#[tokio::test]
async fn enterprise_connections_gate_extra_identifications() {
    let app = test_app_state().await;
    let state = app.state();
    insert_connection(state, "ent_block", "oidc_ent_block", true, false).await;
    let user = create_test_user(state, "enterprise@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    link_external_account(
        state,
        &user.user.id,
        &profile("oidc_ent_block", "sub-1", "enterprise@example.com"),
    )
    .await
    .unwrap();
    let connection = enterprise_connection_for_user(state, &user.user.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(connection.id, "ent_block");
    let error = assert_additional_identifications_allowed(state, &user.user.id)
        .await
        .unwrap_err();
    assert_eq!(error.code, error_codes::NOT_ALLOWED_ACCESS);
    assert_eq!(
        error.meta.unwrap()["enterprise_connection_id"],
        serde_json::json!("ent_block")
    );
}

#[tokio::test]
async fn sync_user_attributes_only_when_the_connection_asks() {
    let app = test_app_state().await;
    let state = app.state();
    insert_connection(state, "ent_sync", "oidc_ent_sync", false, true).await;
    let user = create_test_user(state, "sync@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    link_external_account(
        state,
        &user.user.id,
        &profile("oidc_ent_sync", "sub-2", "sync@example.com"),
    )
    .await
    .unwrap();
    let profile = ExternalProfile {
        provider: "oidc_ent_sync".into(),
        first_name: Some("Ada".into()),
        last_name: Some("Lovelace".into()),
        image_url: Some("https://example.com/ada.png".into()),
        ..Default::default()
    };
    sync_enterprise_user_attributes(state, &user.user.id, &profile)
        .await
        .unwrap();
    let row = orbitid_identity::users::require_user(state, &user.user.id)
        .await
        .unwrap();
    assert_eq!(row.first_name.as_deref(), Some("Ada"));
    assert_eq!(row.last_name.as_deref(), Some("Lovelace"));
    assert_eq!(
        row.image_url.as_deref(),
        Some("https://example.com/ada.png")
    );
    assert!(!row.has_image);

    // Missing claims never clear local values.
    sync_enterprise_user_attributes(
        state,
        &user.user.id,
        &ExternalProfile {
            provider: "oidc_ent_sync".into(),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let row = orbitid_identity::users::require_user(state, &user.user.id)
        .await
        .unwrap();
    assert_eq!(row.first_name.as_deref(), Some("Ada"));

    // A social provider has no connection policy.
    insert_connection(state, "ent_off", "oidc_ent_off", false, false).await;
    let other = create_test_user(state, "no-sync@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    sync_enterprise_user_attributes(
        state,
        &other.user.id,
        &ExternalProfile {
            provider: "google".into(),
            first_name: Some("Nobody".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let row = orbitid_identity::users::require_user(state, &other.user.id)
        .await
        .unwrap();
    assert!(row.first_name.is_none());
}

#[tokio::test]
async fn find_external_account_returns_the_link() {
    let app = test_app_state().await;
    let state = app.state();
    let user = create_test_user(state, "find-link@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let linked = link_external_account(
        state,
        &user.user.id,
        &profile("github", "gh-1", "find-link@example.com"),
    )
    .await
    .unwrap();
    let found = orbitid_identity::external_identity::find_external_account(state, "github", "gh-1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(found.id, linked.id);
    assert!(
        orbitid_identity::external_identity::find_external_account(state, "github", "missing")
            .await
            .unwrap()
            .is_none()
    );
    let _ = new_id(id_prefix::EXTERNAL);
}
