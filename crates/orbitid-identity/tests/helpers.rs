//! Coverage for the `_on` helper families added for the HTTP-crate conversion.
//! Each test drives the helper inside one caller-owned transaction, which is the
//! contract the Backend/Frontend API crates rely on.

use orbitid_core::http::now;
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_identity::orgs::{
    accept_membership_request_on, create_membership_request_on, delete_organization_on,
    leave_organization, leave_organization_on, reject_membership_request_on,
};
use orbitid_identity::restrictions::{
    create_allowlist_identifier_on, create_blocklist_identifier_on, create_invitation_on,
    create_waitlist_entry_on, delete_allowlist_identifier_on, delete_blocklist_identifier_on,
    delete_waitlist_entry_on, revoke_invitation_on, set_waitlist_entry_status_on,
};
use orbitid_identity::testing::{create_test_organization, create_test_user, test_app_state};
use orbitid_identity::user_roles::set_user_roles_on;
use orbitid_identity::users::{moderate_user, ModerationAction};

#[tokio::test]
async fn moderation_ban_revokes_every_credential_in_one_transaction() {
    let app = test_app_state().await;
    let state = app.state();
    let user = create_test_user(state, "ban@helpers.test", "Sup3r-secret!")
        .await
        .unwrap();
    let session = orbitid_identity::testing::create_test_client_session(state, &user.user.id)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO trusted_devices (id, user_id, token_hash, label, expires_at, created_at, updated_at) \
         VALUES ($1,$2,'hash','browser',$3,$3,$3)",
    )
    .bind(new_id(id_prefix::TRUSTED_DEVICE))
    .bind(&user.user.id)
    .bind(now() + 60_000)
    .execute(&state.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO api_keys (id, name, subject, prefix, secret_hash, scopes, created_at, updated_at) \
         VALUES ($1,'key',$2,'ak_test','hash', '[]'::jsonb,$3,$3)",
    )
    .bind(new_id(id_prefix::API_KEY))
    .bind(&user.user.id)
    .bind(now())
    .execute(&state.pool)
    .await
    .unwrap();

    let banned = moderate_user(state, &user.user.id, ModerationAction::Ban)
        .await
        .unwrap();
    assert!(banned.banned);
    let session_status: String = sqlx::query_scalar("SELECT status FROM sessions WHERE id = $1")
        .bind(&session.session.id)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    let devices: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM trusted_devices WHERE user_id = $1 AND revoked_at IS NULL",
    )
    .bind(&user.user.id)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    let keys: i64 =
        sqlx::query_scalar("SELECT count(*) FROM api_keys WHERE subject = $1 AND revoked = false")
            .bind(&user.user.id)
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert_eq!(session_status, "revoked");
    assert_eq!(devices, 0);
    assert_eq!(keys, 0);
    let unbanned = moderate_user(state, &user.user.id, ModerationAction::Unban)
        .await
        .unwrap();
    assert!(!unbanned.banned);
}

#[tokio::test]
async fn delete_user_on_handles_memberships_and_org_lifecycle() {
    let app = test_app_state().await;
    let state = app.state();
    let owner = create_test_user(state, "owner@helpers.test", "Sup3r-secret!")
        .await
        .unwrap();
    let member = create_test_user(state, "member@helpers.test", "Sup3r-secret!")
        .await
        .unwrap();
    let org = create_test_organization(state, "Helpers", None, &owner.user.id)
        .await
        .unwrap();
    orbitid_identity::orgs::add_membership(
        state,
        &org.id,
        &member.user.id,
        "org:member",
        None,
        None,
    )
    .await
    .unwrap();
    orbitid_identity::users::delete_user(state, &owner.user.id)
        .await
        .unwrap();
    let remains: i64 = sqlx::query_scalar("SELECT count(*) FROM organizations WHERE id = $1")
        .bind(&org.id)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    let role: String = sqlx::query_scalar(
        "SELECT role_key FROM organization_memberships WHERE organization_id = $1",
    )
    .bind(&org.id)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert_eq!(
        remains, 1,
        "the organization survives with its remaining member"
    );
    assert_eq!(role, "org:admin", "the remaining member is promoted");
}

#[tokio::test]
async fn set_user_roles_on_replaces_the_assignment_set() {
    let app = test_app_state().await;
    let state = app.state();
    let user = create_test_user(state, "roles@helpers.test", "Sup3r-secret!")
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO roles (id, key, name, description, is_creator_eligible, is_system, \
         created_at, updated_at) VALUES ($1,'app:helper','Helper','',false,false,$2,$2)",
    )
    .bind(new_id(id_prefix::ROLE))
    .bind(now())
    .execute(&state.pool)
    .await
    .unwrap();
    let mut tx = state.pool.begin().await.unwrap();
    let assigned = set_user_roles_on(&mut tx, state, &user.user.id, &["app:helper".into()])
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(assigned, vec!["app:helper".to_string()]);
    let mut tx = state.pool.begin().await.unwrap();
    set_user_roles_on(&mut tx, state, &user.user.id, &[])
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM user_roles WHERE user_id = $1")
        .bind(&user.user.id)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn restriction_helpers_create_and_revoke_in_transactions() {
    let app = test_app_state().await;
    let state = app.state();
    let mut tx = state.pool.begin().await.unwrap();
    let (invitation, ticket) =
        create_invitation_on(&mut tx, state, "invite@helpers.test", None, None, None)
            .await
            .unwrap();
    let allow = create_allowlist_identifier_on(&mut tx, "allow@helpers.test", Some(&invitation.id))
        .await
        .unwrap();
    let block = create_blocklist_identifier_on(&mut tx, "block@helpers.test")
        .await
        .unwrap();
    let wait = create_waitlist_entry_on(&mut tx, "wait@helpers.test")
        .await
        .unwrap();
    let invited = set_waitlist_entry_status_on(&mut tx, &wait.id, "invited", Some(&invitation.id))
        .await
        .unwrap()
        .unwrap();
    tx.commit().await.unwrap();
    assert!(!ticket.is_empty());
    assert_eq!(allow.identifier_type, "email_address");
    assert_eq!(block.identifier_type, "email_address");
    assert_eq!(invited.status, "invited");

    let mut tx = state.pool.begin().await.unwrap();
    revoke_invitation_on(&mut tx, &invitation).await.unwrap();
    assert!(delete_allowlist_identifier_on(&mut tx, &allow.id)
        .await
        .unwrap()
        .is_some());
    assert!(delete_blocklist_identifier_on(&mut tx, &block.id)
        .await
        .unwrap()
        .is_some());
    assert!(delete_waitlist_entry_on(&mut tx, &wait.id)
        .await
        .unwrap()
        .is_some());
    tx.commit().await.unwrap();
    let status: String = sqlx::query_scalar("SELECT status FROM invitations WHERE id = $1")
        .bind(&invitation.id)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(status, "revoked");
}

#[tokio::test]
async fn domain_affiliation_helpers_verify_and_change_the_mode() {
    let app = test_app_state().await;
    let state = app.state();
    let owner = create_test_user(state, "domain@helpers.test", "Sup3r-secret!")
        .await
        .unwrap();
    let org = create_test_organization(state, "Domains", None, &owner.user.id)
        .await
        .unwrap();
    let domain: orbitid_core::models::OrganizationDomainRow = sqlx::query_as(
        "INSERT INTO organization_domains (id, organization_id, name, enrollment_mode, verified, \
         created_at, updated_at) VALUES ($1,$2,'helpers.test','manual_invitation',false,$3,$3) \
         RETURNING *",
    )
    .bind(new_id(id_prefix::DOMAIN))
    .bind(&org.id)
    .bind(now())
    .fetch_one(&state.pool)
    .await
    .unwrap();
    let mut tx = state.pool.begin().await.unwrap();
    let (prepared, code) = orbitid_identity::org_domains::prepare_domain_affiliation_on(
        &mut tx,
        state,
        &domain,
        "admin@helpers.test",
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        prepared.affiliation_email_address.as_deref(),
        Some("admin@helpers.test")
    );
    let mut tx = state.pool.begin().await.unwrap();
    let verified = match orbitid_identity::org_domains::attempt_domain_affiliation_on(
        &mut tx, state, &prepared, &code,
    )
    .await
    .unwrap()
    {
        orbitid_identity::org_domains::DomainAttempt::Verified(row) => row,
        orbitid_identity::org_domains::DomainAttempt::Refused(refusal) => {
            panic!("domain code refused: {}", refusal.error.code)
        }
    };
    tx.commit().await.unwrap();
    assert!(verified.verified);

    let mut tx = state.pool.begin().await.unwrap();
    let updated = orbitid_identity::org_domains::set_domain_enrollment_mode_on(
        &mut tx,
        state,
        &verified,
        "automatic_invitation",
        false,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(updated.enrollment_mode, "automatic_invitation");
}

#[tokio::test]
async fn membership_request_helpers_accept_and_reject_atomically() {
    let app = test_app_state().await;
    let state = app.state();
    let owner = create_test_user(state, "req-owner@helpers.test", "Sup3r-secret!")
        .await
        .unwrap();
    let first = create_test_user(state, "req-a@helpers.test", "Sup3r-secret!")
        .await
        .unwrap();
    let second = create_test_user(state, "req-b@helpers.test", "Sup3r-secret!")
        .await
        .unwrap();
    let org = create_test_organization(state, "Requests", None, &owner.user.id)
        .await
        .unwrap();
    let mut tx = state.pool.begin().await.unwrap();
    let accepted = create_membership_request_on(&mut tx, state, &org, &first.user.id, "pending")
        .await
        .unwrap();
    let rejected = create_membership_request_on(&mut tx, state, &org, &second.user.id, "pending")
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let mut tx = state.pool.begin().await.unwrap();
    let membership = accept_membership_request_on(&mut tx, state, &org, &accepted.id)
        .await
        .unwrap();
    let rejected = reject_membership_request_on(&mut tx, &org, &rejected.id)
        .await
        .unwrap()
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(membership.user_id, first.user.id);
    assert_eq!(rejected.status, "rejected");
    let pending: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM organization_membership_requests WHERE organization_id = $1 \
         AND status = 'pending'",
    )
    .bind(&org.id)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert_eq!(pending, 0);
}

#[tokio::test]
async fn role_and_permission_crud_helpers_commit_events_with_the_rows() {
    let app = test_app_state().await;
    let state = app.state();
    let mut tx = state.pool.begin().await.unwrap();
    let permission = orbitid_identity::rbac::create_permission_on(
        &mut tx,
        &orbitid_identity::rbac::CreatePermissionInput {
            key: "app:helper:read".into(),
            name: "Read helpers".into(),
            description: None,
        },
    )
    .await
    .unwrap();
    let role = orbitid_identity::rbac::create_role_on(
        &mut tx,
        state,
        &orbitid_identity::rbac::CreateRoleInput {
            key: "app:helper".into(),
            name: "Helper".into(),
            description: None,
            is_creator_eligible: false,
            permission_keys: vec!["app:helper:read".into()],
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let links: i64 = sqlx::query_scalar("SELECT count(*) FROM role_permissions WHERE role_id = $1")
        .bind(&role.id)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(links, 1);

    let mut tx = state.pool.begin().await.unwrap();
    let updated = orbitid_identity::rbac::update_role_on(
        &mut tx,
        state,
        &role,
        Some("Renamed"),
        None,
        None,
        Some(&[]),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(updated.name, "Renamed");
    let links: i64 = sqlx::query_scalar("SELECT count(*) FROM role_permissions WHERE role_id = $1")
        .bind(&role.id)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(links, 0);

    let mut tx = state.pool.begin().await.unwrap();
    orbitid_identity::rbac::delete_role_on(&mut tx, state, &updated)
        .await
        .unwrap();
    let updated_permission = orbitid_identity::rbac::update_permission_on(
        &mut tx,
        &permission,
        Some("Read renamed"),
        None,
    )
    .await
    .unwrap();
    orbitid_identity::rbac::delete_permission_on(&mut tx, &updated_permission)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let roles: i64 = sqlx::query_scalar("SELECT count(*) FROM roles WHERE id = $1")
        .bind(&role.id)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    let permissions: i64 = sqlx::query_scalar("SELECT count(*) FROM permissions WHERE id = $1")
        .bind(&permission.id)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(roles, 0);
    assert_eq!(permissions, 0);
}

#[tokio::test]
async fn organization_delete_and_leave_helpers_share_the_last_admin_rule() {
    let app = test_app_state().await;
    let state = app.state();
    let owner = create_test_user(state, "leave-owner@helpers.test", "Sup3r-secret!")
        .await
        .unwrap();
    let member = create_test_user(state, "leave-member@helpers.test", "Sup3r-secret!")
        .await
        .unwrap();
    let org = create_test_organization(state, "Leaving", None, &owner.user.id)
        .await
        .unwrap();
    orbitid_identity::orgs::add_membership(
        state,
        &org.id,
        &member.user.id,
        "org:member",
        None,
        None,
    )
    .await
    .unwrap();
    leave_organization(state, &org.id, &member.user.id)
        .await
        .unwrap();
    let blocks = leave_organization(state, &org.id, &owner.user.id).await;
    assert!(blocks.is_err(), "the last admin cannot leave");
    let mut tx = state.pool.begin().await.unwrap();
    let deleted = delete_organization_on(&mut tx, state, &org.id)
        .await
        .unwrap()
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(deleted.organization.id, org.id);
    let gone: i64 = sqlx::query_scalar("SELECT count(*) FROM organizations WHERE id = $1")
        .bind(&org.id)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(gone, 0);
}

#[tokio::test]
async fn leave_organization_on_rolls_back_below_two_admins() {
    let app = test_app_state().await;
    let state = app.state();
    let owner = create_test_user(state, "leave-on@helpers.test", "Sup3r-secret!")
        .await
        .unwrap();
    let org = create_test_organization(state, "LastAdmin", None, &owner.user.id)
        .await
        .unwrap();
    let mut tx = state.pool.begin().await.unwrap();
    let result = leave_organization_on(&mut tx, state, &org.id, &owner.user.id).await;
    assert!(result.is_err());
    let still: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM organization_memberships WHERE organization_id = $1",
    )
    .bind(&org.id)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    tx.rollback().await.unwrap();
    assert_eq!(still, 1);
}
