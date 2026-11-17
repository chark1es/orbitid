//! Organization-authority grant revocation by the lifecycle paths that change
//! authority without an explicit admin action: last-admin promotion on user
//! deletion and organization deletion (set-based, however many members).

#![allow(clippy::unwrap_used, clippy::expect_used)]

use orbitid_core::http::now;
use orbitid_core::AppState;
use orbitid_identity::orgs::{delete_organization, on_user_deleted};
use orbitid_identity::testing::{
    add_test_member, create_test_guest, create_test_organization, create_test_user, test_app_state,
};

async fn authority_application(state: &AppState) {
    sqlx::query(
        "INSERT INTO oauth_applications (id, name, client_id, redirect_uris, scopes, \
         groups_claim, created_at, updated_at) \
         VALUES ('oa_authority','App','client_authority','[]'::jsonb,'openid organizations',\
         'all',$1,$1)",
    )
    .bind(now())
    .execute(&state.pool)
    .await
    .unwrap();
}

async fn give_grants(state: &AppState, user_id: &str) {
    for (kind, suffix) in [("access", "a"), ("refresh", "r")] {
        sqlx::query(
            "INSERT INTO oauth_grants (id, kind, application_id, user_id, token_hash, scopes, \
             family_id, revoked, expires_at, created_at) \
             VALUES ($1,$2,'oa_authority',$3,$4,'openid organizations',$5,false,$6,$7)",
        )
        .bind(format!("g_{user_id}_{suffix}"))
        .bind(kind)
        .bind(user_id)
        .bind(format!("hash_{user_id}_{suffix}"))
        .bind(format!("fam_{user_id}"))
        .bind(now() + 3_600_000)
        .bind(now())
        .execute(&state.pool)
        .await
        .unwrap();
    }
}

async fn live_grants(state: &AppState, user_ids: &[String]) -> i64 {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM oauth_grants WHERE user_id = ANY($1) AND revoked = false",
    )
    .bind(user_ids)
    .fetch_one(&state.pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn promotion_on_creator_deletion_revokes_the_promoted_members_grants() {
    let app = test_app_state().await;
    let state = app.state();
    authority_application(state).await;
    let owner = create_test_user(state, "owner-revoke@acme.test", "Sup3r-secret!")
        .await
        .unwrap();
    let first = create_test_user(state, "first-revoke@acme.test", "Sup3r-secret!")
        .await
        .unwrap();
    let second = create_test_user(state, "second-revoke@acme.test", "Sup3r-secret!")
        .await
        .unwrap();
    let org = create_test_organization(state, "Revoke Inc", None, &owner.user.id)
        .await
        .unwrap();
    add_test_member(state, &org.id, &first.user.id, "org:member")
        .await
        .unwrap();
    add_test_member(state, &org.id, &second.user.id, "org:member")
        .await
        .unwrap();
    give_grants(state, &first.user.id).await;
    give_grants(state, &second.user.id).await;

    on_user_deleted(state, &owner.user.id).await.unwrap();

    let role: String = sqlx::query_scalar(
        "SELECT role_key FROM organization_memberships WHERE organization_id = $1 \
         AND user_id = $2",
    )
    .bind(&org.id)
    .bind(&first.user.id)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert_eq!(role, "org:admin");
    assert_eq!(
        live_grants(state, std::slice::from_ref(&first.user.id)).await,
        0,
        "the promoted member's tokens are revoked so they re-issue with the new role"
    );
    assert_eq!(
        live_grants(state, std::slice::from_ref(&second.user.id)).await,
        2,
        "an unchanged member keeps their tokens"
    );
}

#[tokio::test]
async fn organization_deletion_revokes_every_members_grants_set_based() {
    let app = test_app_state().await;
    let state = app.state();
    authority_application(state).await;
    let owner = create_test_user(state, "owner-many@acme.test", "Sup3r-secret!")
        .await
        .unwrap();
    let org = create_test_organization(state, "Many Inc", None, &owner.user.id)
        .await
        .unwrap();
    let outsider = create_test_user(state, "outsider-many@acme.test", "Sup3r-secret!")
        .await
        .unwrap();
    give_grants(state, &outsider.user.id).await;
    let mut members = vec![owner.user.id.clone()];
    give_grants(state, &owner.user.id).await;
    for _ in 0..200 {
        let user = create_test_guest(state).await.unwrap();
        add_test_member(state, &org.id, &user.id, "org:member")
            .await
            .unwrap();
        give_grants(state, &user.id).await;
        members.push(user.id.clone());
    }

    let deleted = delete_organization(state, &org.id).await.unwrap().unwrap();
    assert_eq!(deleted.member_ids.len(), 201);
    assert_eq!(live_grants(state, &members).await, 0);
    assert_eq!(
        live_grants(state, std::slice::from_ref(&outsider.user.id)).await,
        2,
        "a user outside the organization keeps their tokens"
    );
}

#[tokio::test]
async fn organization_deletion_with_hundreds_of_families_revokes_all() {
    let app = test_app_state().await;
    let state = app.state();
    authority_application(state).await;
    let owner = create_test_user(state, "owner-families@acme.test", "Sup3r-secret!")
        .await
        .unwrap();
    let org = create_test_organization(state, "Families Inc", None, &owner.user.id)
        .await
        .unwrap();
    let mut members = vec![owner.user.id.clone()];
    for _ in 0..149 {
        let user = create_test_guest(state).await.unwrap();
        add_test_member(state, &org.id, &user.id, "org:member")
            .await
            .unwrap();
        members.push(user.id.clone());
    }
    // 150 members x 2 families = 300 families, one grant row each.
    for user_id in &members {
        for family in 0..2 {
            sqlx::query(
                "INSERT INTO oauth_grants (id, kind, application_id, user_id, token_hash, \
                 scopes, family_id, revoked, expires_at, created_at) \
                 VALUES ($1,'refresh','oa_authority',$2,$3,'openid organizations',$4,false,$5,$6)",
            )
            .bind(format!("gf_{user_id}_{family}"))
            .bind(user_id)
            .bind(format!("hashf_{user_id}_{family}"))
            .bind(format!("famf_{user_id}_{family}"))
            .bind(now() + 3_600_000)
            .bind(now())
            .execute(&state.pool)
            .await
            .unwrap();
        }
    }
    assert_eq!(live_grants(state, &members).await, 300);

    delete_organization(state, &org.id).await.unwrap().unwrap();
    assert_eq!(live_grants(state, &members).await, 0);
}
