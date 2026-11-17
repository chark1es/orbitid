//! Ported from `test/orgs/oidc-revocation.test.ts`: organization/group
//! authority grants are revoked when a membership changes, without ending the
//! browser session.

mod common;

use orbitid_oidc::services::oidc::applications::{create_application, CreateApplicationInput};
use orbitid_oidc::services::oidc::revocation::revoke_organization_authority_grants;

use common::{harness, insert_user};

async fn seed_grant(state: &orbitid_core::AppState, application_id: &str, user_id: &str) -> String {
    let id = orbitid_core::ids::new_id(orbitid_core::ids::id_prefix::OAUTH_GRANT);
    let now = orbitid_core::http::now();
    sqlx::query(
        "INSERT INTO oauth_grants (id, kind, application_id, user_id, token_hash, scopes, \
         family_id, revoked, expires_at, created_at) \
         VALUES ($1,'refresh',$2,$3,$4,'openid',$5,false,$6,$7)",
    )
    .bind(&id)
    .bind(application_id)
    .bind(user_id)
    .bind(orbitid_core::crypto::sha256(&format!("hash_{id}")))
    .bind(format!("family_{id}"))
    .bind(now + 3_600_000)
    .bind(now)
    .execute(&state.pool)
    .await
    .unwrap();
    id
}

async fn revoked(state: &orbitid_core::AppState, id: &str) -> bool {
    sqlx::query_scalar("SELECT revoked FROM oauth_grants WHERE id = $1")
        .bind(id)
        .fetch_one(&state.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn only_organization_authority_grants_are_revoked() {
    let h = harness().await;
    let browser = insert_user(&h, "member@example.com").await;
    let state = h.state();
    let (authority, _) = create_application(
        state,
        CreateApplicationInput {
            name: "Authority".into(),
            scopes: Some("openid groups organizations".into()),
            groups_claim: Some("all".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let (unrelated, _) = create_application(
        state,
        CreateApplicationInput {
            name: "Unrelated".into(),
            scopes: Some("openid profile email".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let (groups_none, _) = create_application(
        state,
        CreateApplicationInput {
            name: "Groups none".into(),
            scopes: Some("openid groups".into()),
            groups_claim: Some("none".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let (org_claims_only, _) = create_application(
        state,
        CreateApplicationInput {
            name: "Organizations only".into(),
            scopes: Some("openid offline_access organizations".into()),
            groups_claim: Some("none".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let authority_grant = seed_grant(state, &authority.id, &browser.user.id).await;
    let org_claims_grant = seed_grant(state, &org_claims_only.id, &browser.user.id).await;
    let unrelated_grant = seed_grant(state, &unrelated.id, &browser.user.id).await;
    let none_grant = seed_grant(state, &groups_none.id, &browser.user.id).await;

    revoke_organization_authority_grants(state, &browser.user.id)
        .await
        .unwrap();

    assert!(revoked(state, &authority_grant).await);
    assert!(
        revoked(state, &org_claims_grant).await,
        "organization claims ignore groups_claim, so the grant must be revoked"
    );
    assert!(!revoked(state, &unrelated_grant).await);
    assert!(!revoked(state, &none_grant).await);
    // Only the OIDC grants end; the browser session stays signed in.
    let status: String = sqlx::query_scalar("SELECT status FROM sessions WHERE id = $1")
        .bind(&browser.session_id)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(status, "active");
}
