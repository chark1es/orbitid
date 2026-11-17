use orbitid_core::error::error_codes;
use orbitid_core::http::now;
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_identity::org_shared::{
    normalize_slug, org_access, require_membership, resolve_slug, slugify,
};
use orbitid_identity::orgs::{
    accept_invitation, assert_organization_capacity, create_organization_invitation,
    delete_organization, on_user_deleted, on_user_email_verified, CreateInvitationInput,
};
use orbitid_identity::testing::{
    add_test_member, create_test_client_session, create_test_organization, create_test_user,
    test_app_state,
};
use orbitid_identity::uploads::{
    delete_upload_by_url_on, read_upload, store_upload_on, LOGO_BUCKET, LOGO_MARKER,
};

async fn insert_domain(
    state: &orbitid_core::AppState,
    org_id: &str,
    name: &str,
    mode: &str,
    verified: bool,
) -> orbitid_core::models::OrganizationDomainRow {
    let now_ms = now();
    let id = new_id(id_prefix::DOMAIN);
    sqlx::query_as::<_, orbitid_core::models::OrganizationDomainRow>(
        "INSERT INTO organization_domains (id, organization_id, name, enrollment_mode, verified, \
         created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING *",
    )
    .bind(&id)
    .bind(org_id)
    .bind(name)
    .bind(mode)
    .bind(verified)
    .bind(now_ms)
    .fetch_one(&state.pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn invitations_are_unique_and_accept_on_email_verification() {
    let app = test_app_state().await;
    let state = app.state();
    let owner = create_test_user(state, "owner@acme.test", "Sup3r-secret!")
        .await
        .unwrap();
    let org = create_test_organization(state, "Acme", Some("acme"), &owner.user.id)
        .await
        .unwrap();
    let (invitation, ticket) = create_organization_invitation(
        state,
        &org,
        &CreateInvitationInput {
            email: "Invitee@Acme.test".into(),
            role_key: None,
            inviter_user_id: Some(owner.user.id.clone()),
            redirect_url: None,
            public_metadata: None,
            private_metadata: None,
            expires_at: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(invitation.email, "invitee@acme.test");
    assert_eq!(invitation.status, "pending");
    assert_eq!(invitation.role_key, "org:member");
    assert!(!ticket.is_empty());

    let duplicate = create_organization_invitation(
        state,
        &org,
        &CreateInvitationInput {
            email: "invitee@acme.test".into(),
            role_key: None,
            inviter_user_id: None,
            redirect_url: None,
            public_metadata: None,
            private_metadata: None,
            expires_at: None,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(duplicate.code, error_codes::DUPLICATE_RECORD);

    let bad_role = create_organization_invitation(
        state,
        &org,
        &CreateInvitationInput {
            email: "other@acme.test".into(),
            role_key: Some("org:nope".into()),
            inviter_user_id: None,
            redirect_url: None,
            public_metadata: None,
            private_metadata: None,
            expires_at: None,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(bad_role.code, error_codes::ORG_ROLE_NOT_FOUND);

    let invitee = create_test_user(state, "invitee@acme.test", "Sup3r-secret!")
        .await
        .unwrap();
    on_user_email_verified(state, &invitee.user.id, "invitee@acme.test")
        .await
        .unwrap();
    let membership =
        orbitid_identity::org_shared::find_membership(state, &org.id, &invitee.user.id)
            .await
            .unwrap()
            .expect("membership accepted");
    assert_eq!(membership.role_key, "org:member");

    let accepted = sqlx::query_scalar::<_, String>(
        "SELECT status FROM organization_invitations WHERE id = $1",
    )
    .bind(&invitation.id)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert_eq!(accepted, "accepted");

    // Idempotent: verifying again does not duplicate or fail.
    on_user_email_verified(state, &invitee.user.id, "invitee@acme.test")
        .await
        .unwrap();
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM organization_memberships WHERE organization_id = $1 AND user_id = $2",
    )
    .bind(&org.id)
    .bind(&invitee.user.id)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn revoked_invitation_never_leaves_a_membership() {
    let app = test_app_state().await;
    let state = app.state();
    let owner = create_test_user(state, "owner2@acme.test", "Sup3r-secret!")
        .await
        .unwrap();
    let invitee = create_test_user(state, "late@acme.test", "Sup3r-secret!")
        .await
        .unwrap();
    let org = create_test_organization(state, "Acme 2", None, &owner.user.id)
        .await
        .unwrap();
    let (invitation, _) = create_organization_invitation(
        state,
        &org,
        &CreateInvitationInput {
            email: "late@acme.test".into(),
            role_key: None,
            inviter_user_id: None,
            redirect_url: None,
            public_metadata: None,
            private_metadata: None,
            expires_at: None,
        },
    )
    .await
    .unwrap();
    sqlx::query("UPDATE organization_invitations SET status = 'revoked' WHERE id = $1")
        .bind(&invitation.id)
        .execute(&state.pool)
        .await
        .unwrap();
    let stale = sqlx::query_as::<_, orbitid_core::models::OrganizationInvitationRow>(
        "SELECT * FROM organization_invitations WHERE id = $1",
    )
    .bind(&invitation.id)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    let result = accept_invitation(state, &stale, &invitee.user.id)
        .await
        .unwrap();
    assert!(result.is_none());
    let memberships: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM organization_memberships WHERE user_id = $1")
            .bind(&invitee.user.id)
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert_eq!(memberships, 0);
    let accepted_events: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM webhook_events WHERE type = 'organizationInvitation.accepted'",
    )
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert_eq!(accepted_events, 0);
}

#[tokio::test]
async fn parallel_invitation_acceptance_creates_one_membership() {
    let app = test_app_state().await;
    let state = app.state();
    let owner = create_test_user(state, "owner3@acme.test", "Sup3r-secret!")
        .await
        .unwrap();
    let invitee = create_test_user(state, "race@acme.test", "Sup3r-secret!")
        .await
        .unwrap();
    let org = create_test_organization(state, "Concurrency Co", None, &owner.user.id)
        .await
        .unwrap();
    let (invitation, _) = create_organization_invitation(
        state,
        &org,
        &CreateInvitationInput {
            email: "race@acme.test".into(),
            role_key: None,
            inviter_user_id: None,
            redirect_url: None,
            public_metadata: None,
            private_metadata: None,
            expires_at: None,
        },
    )
    .await
    .unwrap();
    let mut tasks = Vec::new();
    for _ in 0..8 {
        let state = state.clone();
        let invitation = invitation.clone();
        let user_id = invitee.user.id.clone();
        tasks.push(tokio::spawn(async move {
            accept_invitation(&state, &invitation, &user_id).await
        }));
    }
    for task in tasks {
        task.await.unwrap().unwrap();
    }
    let memberships: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM organization_memberships WHERE organization_id = $1 AND user_id = $2",
    )
    .bind(&org.id)
    .bind(&invitee.user.id)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert_eq!(memberships, 1);
    let accepted_events: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM webhook_events WHERE type = 'organizationInvitation.accepted'",
    )
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert_eq!(accepted_events, 1);
}

#[tokio::test]
async fn automatic_domain_enrollment_adds_verified_users_only() {
    let app = test_app_state().await;
    let state = app.state();
    let owner = create_test_user(state, "owner@auto.test", "Sup3r-secret!")
        .await
        .unwrap();
    let existing = create_test_user(state, "existing@auto.test", "Sup3r-secret!")
        .await
        .unwrap();
    let unverified =
        orbitid_identity::testing::create_test_unverified_user(state, "unverified@auto.test")
            .await
            .unwrap();
    create_test_organization(state, "Auto Inc", None, &owner.user.id)
        .await
        .unwrap();
    let org = sqlx::query_as::<_, orbitid_core::models::OrganizationRow>(
        "SELECT * FROM organizations WHERE slug = 'auto-inc'",
    )
    .fetch_one(&state.pool)
    .await
    .unwrap();
    let domain = insert_domain(state, &org.id, "auto.test", "automatic_invitation", true).await;
    let added = orbitid_identity::orgs::apply_domain_enrollment(state, &domain, &[])
        .await
        .unwrap();
    assert_eq!(added, 1);
    let members: Vec<String> = sqlx::query_scalar(
        "SELECT user_id FROM organization_memberships WHERE organization_id = $1",
    )
    .bind(&org.id)
    .fetch_all(&state.pool)
    .await
    .unwrap();
    assert!(members.contains(&existing.user.id));
    assert!(!members.contains(&unverified.user.id));

    let newcomer = create_test_user(state, "newcomer@auto.test", "Sup3r-secret!")
        .await
        .unwrap();
    on_user_email_verified(state, &newcomer.user.id, "newcomer@auto.test")
        .await
        .unwrap();
    let membership =
        orbitid_identity::org_shared::find_membership(state, &org.id, &newcomer.user.id)
            .await
            .unwrap();
    assert!(membership.is_some());
}

#[tokio::test]
async fn suggestions_are_derived_and_disappear_after_joining() {
    let app = test_app_state().await;
    let state = app.state();
    let owner = create_test_user(state, "owner@suggest.test", "Sup3r-secret!")
        .await
        .unwrap();
    let org = create_test_organization(state, "Zeta Inc", None, &owner.user.id)
        .await
        .unwrap();
    insert_domain(state, &org.id, "suggest.test", "automatic_suggestion", true).await;
    let user = create_test_user(state, "person@suggest.test", "Sup3r-secret!")
        .await
        .unwrap();
    let suggestions = orbitid_identity::org_domains::suggested_organizations(state, &user.user.id)
        .await
        .unwrap();
    assert_eq!(suggestions.len(), 1);
    assert_eq!(suggestions[0].0.id, org.id);
    assert!(
        orbitid_identity::org_domains::has_suggestion_for_organization(
            state,
            &user.user.id,
            &org.id
        )
        .await
        .unwrap()
    );
    let json = orbitid_identity::org_serializers::serialize_suggestion(
        state,
        &suggestions[0].0,
        &suggestions[0].1,
        "pending",
    )
    .await
    .unwrap();
    assert_eq!(
        json.id,
        orbitid_identity::org_serializers::suggestion_id(&org.id)
    );
    assert_eq!(json.public_organization_data.id, org.id);

    add_test_member(state, &org.id, &user.user.id, "org:member")
        .await
        .unwrap();
    assert!(
        orbitid_identity::org_domains::suggested_organizations(state, &user.user.id)
            .await
            .unwrap()
            .is_empty()
    );
}

/// An unlimited organization (cap 0, the default) never runs a count under the
/// organization lock. Observable effect: with the tables made unresolvable
/// (`search_path` emptied) the unlimited check still succeeds, while the same
/// check for a capped organization has to query and therefore fails.
#[tokio::test]
async fn unlimited_organization_capacity_runs_no_count() {
    let app = test_app_state().await;
    let state = app.state();
    let owner = create_test_user(state, "owner-unl@acme.test", "Sup3r-secret!")
        .await
        .unwrap();
    let org = create_test_organization(state, "Unlimited Inc", None, &owner.user.id)
        .await
        .unwrap();
    let mut org = sqlx::query_as::<_, orbitid_core::models::OrganizationRow>(
        "SELECT * FROM organizations WHERE id = $1",
    )
    .bind(&org.id)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    org.max_allowed_memberships = 0;
    let mut tx = state.pool.begin().await.unwrap();
    let lock = orbitid_identity::locks::lock_membership_write_on(
        &mut tx,
        &[],
        std::slice::from_ref(&org.id),
    )
    .await
    .unwrap();
    sqlx::query("SET LOCAL search_path = pg_catalog")
        .execute(&mut *tx)
        .await
        .unwrap();
    orbitid_identity::orgs::assert_organization_capacity_on(&mut tx, &org, true, &lock)
        .await
        .unwrap();
    org.max_allowed_memberships = 5;
    orbitid_identity::orgs::assert_organization_capacity_on(&mut tx, &org, true, &lock)
        .await
        .unwrap_err();
    tx.rollback().await.unwrap();
}

#[tokio::test]
async fn organization_capacity_counts_pending_invitations() {
    let app = test_app_state().await;
    let state = app.state();
    let owner = create_test_user(state, "owner-cap@acme.test", "Sup3r-secret!")
        .await
        .unwrap();
    let org = create_test_organization(state, "Cap Inc", None, &owner.user.id)
        .await
        .unwrap();
    sqlx::query("UPDATE organizations SET max_allowed_memberships = 2 WHERE id = $1")
        .bind(&org.id)
        .execute(&state.pool)
        .await
        .unwrap();
    let org = sqlx::query_as::<_, orbitid_core::models::OrganizationRow>(
        "SELECT * FROM organizations WHERE id = $1",
    )
    .bind(&org.id)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    create_organization_invitation(
        state,
        &org,
        &CreateInvitationInput {
            email: "one@acme.test".into(),
            role_key: None,
            inviter_user_id: None,
            redirect_url: None,
            public_metadata: None,
            private_metadata: None,
            expires_at: None,
        },
    )
    .await
    .unwrap();
    let error = create_organization_invitation(
        state,
        &org,
        &CreateInvitationInput {
            email: "two@acme.test".into(),
            role_key: None,
            inviter_user_id: None,
            redirect_url: None,
            public_metadata: None,
            private_metadata: None,
            expires_at: None,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(
        error.code,
        error_codes::ORGANIZATION_MEMBERSHIP_QUOTA_EXCEEDED
    );
    // Adding a member does not count pending invitations (the TS contract),
    // but the organization is now full once invitations are considered.
    let member = create_test_user(state, "member-cap@acme.test", "Sup3r-secret!")
        .await
        .unwrap();
    add_test_member(state, &org.id, &member.user.id, "org:member")
        .await
        .unwrap();
    assert_organization_capacity(state, &org, true)
        .await
        .unwrap_err();
    let extra = create_test_user(state, "extra-cap@acme.test", "Sup3r-secret!")
        .await
        .unwrap();
    let error = add_test_member(state, &org.id, &extra.user.id, "org:member")
        .await
        .unwrap_err();
    assert_eq!(
        error.code,
        error_codes::ORGANIZATION_MEMBERSHIP_QUOTA_EXCEEDED
    );
}

#[tokio::test]
async fn deleting_the_last_member_deletes_the_organization() {
    let app = test_app_state().await;
    let state = app.state();
    let owner = create_test_user(state, "solo@acme.test", "Sup3r-secret!")
        .await
        .unwrap();
    let org = create_test_organization(state, "Solo Inc", None, &owner.user.id)
        .await
        .unwrap();
    on_user_deleted(state, &owner.user.id).await.unwrap();
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM organizations WHERE id = $1)")
            .bind(&org.id)
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert!(!exists);
    let deleted_events: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM webhook_events WHERE type = 'organization.deleted'",
    )
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert_eq!(deleted_events, 1);
}

#[tokio::test]
async fn deleting_an_admin_promotes_the_oldest_member() {
    let app = test_app_state().await;
    let state = app.state();
    let owner = create_test_user(state, "owner-promote@acme.test", "Sup3r-secret!")
        .await
        .unwrap();
    let first = create_test_user(state, "first@acme.test", "Sup3r-secret!")
        .await
        .unwrap();
    let second = create_test_user(state, "second@acme.test", "Sup3r-secret!")
        .await
        .unwrap();
    let org = create_test_organization(state, "Promote Inc", None, &owner.user.id)
        .await
        .unwrap();
    add_test_member(state, &org.id, &first.user.id, "org:member")
        .await
        .unwrap();
    add_test_member(state, &org.id, &second.user.id, "org:member")
        .await
        .unwrap();
    on_user_deleted(state, &owner.user.id).await.unwrap();
    let promoted = orbitid_identity::org_shared::find_membership(state, &org.id, &first.user.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(promoted.role_key, "org:admin");
    let other = orbitid_identity::org_shared::find_membership(state, &org.id, &second.user.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(other.role_key, "org:member");
}

#[tokio::test]
async fn organization_access_checks_membership_and_permissions() {
    let app = test_app_state().await;
    let state = app.state();
    state
        .settings
        .update(serde_json::json!({ "organizations": { "enabled": true } }))
        .await
        .unwrap();
    let owner = create_test_user(state, "owner-access@acme.test", "Sup3r-secret!")
        .await
        .unwrap();
    let member = create_test_user(state, "member-access@acme.test", "Sup3r-secret!")
        .await
        .unwrap();
    create_test_client_session(state, &member.user.id)
        .await
        .unwrap();
    let org = create_test_organization(state, "Access Inc", None, &owner.user.id)
        .await
        .unwrap();
    add_test_member(state, &org.id, &member.user.id, "org:member")
        .await
        .unwrap();
    let access = org_access(
        state,
        &org.id,
        &member.user.id,
        Some("org:sys_memberships:read"),
    )
    .await
    .unwrap();
    assert_eq!(access.membership.role_key, "org:member");
    let denied = org_access(
        state,
        &org.id,
        &member.user.id,
        Some("org:sys_memberships:manage"),
    )
    .await
    .unwrap_err();
    assert_eq!(denied.code, error_codes::ORG_PERMISSION_REQUIRED);
    let outsider = create_test_user(state, "outsider@elsewhere.test", "Sup3r-secret!")
        .await
        .unwrap();
    let missing = require_membership(state, &org, &outsider.user.id, "")
        .await
        .unwrap_err();
    assert_eq!(missing.code, error_codes::NOT_A_MEMBER_IN_ORGANIZATION);
    assert_eq!(missing.status.as_u16(), 404);
}

#[tokio::test]
async fn slug_resolution_and_reserved_names() {
    let app = test_app_state().await;
    let state = app.state();
    assert_eq!(slugify("Acme Test Inc"), "acme-test-inc");
    assert_eq!(slugify("Café"), "cafe");
    assert!(normalize_slug("api").is_err());
    assert!(normalize_slug("Bad Slug").is_err());
    let owner = create_test_user(state, "slug@acme.test", "Sup3r-secret!")
        .await
        .unwrap();
    let org = create_test_organization(state, "First", Some("taken"), &owner.user.id)
        .await
        .unwrap();
    assert_eq!(
        resolve_slug(state, None, "Taken", None).await.unwrap(),
        "taken-2"
    );
    assert_eq!(
        resolve_slug(state, Some("taken"), "Other", Some(&org.id))
            .await
            .unwrap(),
        "taken"
    );
    let error = resolve_slug(state, Some("taken"), "Other", None)
        .await
        .unwrap_err();
    assert_eq!(error.code, error_codes::ORGANIZATION_SLUG_TAKEN);
}

#[tokio::test]
async fn domain_pending_counts_and_deletion() {
    let app = test_app_state().await;
    let state = app.state();
    let owner = create_test_user(state, "owner@switch.test", "Sup3r-secret!")
        .await
        .unwrap();
    let org = create_test_organization(state, "Switch Inc", None, &owner.user.id)
        .await
        .unwrap();
    let domain = insert_domain(state, &org.id, "switch.test", "manual_invitation", true).await;
    create_organization_invitation(
        state,
        &org,
        &CreateInvitationInput {
            email: "pending@switch.test".into(),
            role_key: None,
            inviter_user_id: None,
            redirect_url: None,
            public_metadata: None,
            private_metadata: None,
            expires_at: None,
        },
    )
    .await
    .unwrap();
    let member = create_test_user(state, "member@switch.test", "Sup3r-secret!")
        .await
        .unwrap();
    add_test_member(state, &org.id, &member.user.id, "org:member")
        .await
        .unwrap();
    let pending = orbitid_identity::org_domains::pending_invitations_for_domain(
        state,
        &org.id,
        "switch.test",
    )
    .await
    .unwrap();
    assert_eq!(pending, 1);
    let json = orbitid_identity::org_serializers::serialize_organization_domain(state, &domain)
        .await
        .unwrap();
    assert_eq!(json.total_pending_invitations, 1);
    assert_eq!(json.total_pending_suggestions, 0);
    assert_eq!(
        json.verification.unwrap().status,
        orbitid_core::resources::VerificationStatus::Verified
    );
    let removed =
        orbitid_identity::org_domains::delete_pending_for_domain(state, &org.id, "SWITCH.test")
            .await
            .unwrap();
    assert_eq!(removed.len(), 1);
    assert_eq!(
        orbitid_identity::org_domains::pending_invitations_for_domain(
            state,
            &org.id,
            "switch.test"
        )
        .await
        .unwrap(),
        0
    );
}

#[tokio::test]
async fn deleting_a_logo_removes_the_upload_row() {
    let app = test_app_state().await;
    let state = app.state();
    let owner = create_test_user(state, "logo-delete@acme.test", "Sup3r-secret!")
        .await
        .unwrap();
    let org = create_test_organization(state, "Logo Inc", Some("logo-inc"), &owner.user.id)
        .await
        .unwrap();
    let file = format!("{}_0123456789abcdef01234567.png", org.id);
    let image_url = format!("http://localhost:4000/v1/client/organization_logos/{file}");
    let mut conn = state.pool.acquire().await.unwrap();
    store_upload_on(&mut conn, LOGO_BUCKET, &org.id, &file, "image/png", b"png")
        .await
        .unwrap();
    sqlx::query("UPDATE organizations SET image_url = $1, has_image = true WHERE id = $2")
        .bind(&image_url)
        .bind(&org.id)
        .execute(&mut *conn)
        .await
        .unwrap();
    drop(conn);

    delete_organization(state, &org.id).await.unwrap();
    assert!(
        read_upload(state, LOGO_BUCKET, &file)
            .await
            .unwrap()
            .is_none(),
        "the upload row must be deleted with the organization"
    );
    assert!(
        read_upload(state, LOGO_BUCKET, "../secret")
            .await
            .unwrap()
            .is_none(),
        "traversal attempts never resolve to a row"
    );
    // Traversal-shaped pointers are ignored rather than deleting another row.
    let mut conn = state.pool.acquire().await.unwrap();
    delete_upload_by_url_on(
        &mut conn,
        LOGO_BUCKET,
        LOGO_MARKER,
        Some("http://localhost:4000/v1/client/organization_logos/../secret"),
    )
    .await
    .unwrap();
}

/// Accepting an invitation inserts the membership, flips the invitation and
/// writes both events in one transaction. A failure at the event write must
/// leave the invitation pending and no membership behind.
#[tokio::test]
async fn invitation_acceptance_rolls_back_when_its_event_cannot_be_written() {
    let app = test_app_state().await;
    let state = app.state();
    let owner = create_test_user(state, "atomic-owner@acme.test", "Sup3r-secret!")
        .await
        .unwrap();
    let org = create_test_organization(state, "Atomic", Some("atomic"), &owner.user.id)
        .await
        .unwrap();
    let invitee = create_test_user(state, "atomic-invitee@acme.test", "Sup3r-secret!")
        .await
        .unwrap();
    let (invitation, _) = create_organization_invitation(
        state,
        &org,
        &CreateInvitationInput {
            email: "atomic-invitee@acme.test".into(),
            role_key: None,
            inviter_user_id: Some(owner.user.id.clone()),
            redirect_url: None,
            public_metadata: None,
            private_metadata: None,
            expires_at: None,
        },
    )
    .await
    .unwrap();

    sqlx::query(
        "CREATE OR REPLACE FUNCTION orbitid_test_fail_event() RETURNS trigger AS $$ \
         BEGIN RAISE EXCEPTION 'injected event failure'; END; $$ LANGUAGE plpgsql",
    )
    .execute(&state.pool)
    .await
    .unwrap();
    sqlx::query(
        "CREATE TRIGGER orbitid_test_fail_event BEFORE INSERT ON webhook_events \
         FOR EACH ROW EXECUTE FUNCTION orbitid_test_fail_event()",
    )
    .execute(&state.pool)
    .await
    .unwrap();

    assert!(accept_invitation(state, &invitation, &invitee.user.id)
        .await
        .is_err());
    let status: String =
        sqlx::query_scalar("SELECT status FROM organization_invitations WHERE id = $1")
            .bind(&invitation.id)
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert_eq!(status, "pending", "the invitation must stay pending");
    let memberships: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM organization_memberships WHERE organization_id = $1 AND user_id = $2",
    )
    .bind(&org.id)
    .bind(&invitee.user.id)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert_eq!(memberships, 0, "no membership may survive the rollback");
}
