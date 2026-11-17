use orbitid_core::error::error_codes;
use orbitid_core::http::now;
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::resources::VerificationStatus;
use orbitid_identity::anonymous::{cleanup_anonymous_users, stale_anonymous_user_ids};
use orbitid_identity::restrictions::{
    assert_identifiers_allowed, mark_invitation_accepted, pending_invitation_for, redeem_ticket,
    validate_ticket, IdentifiersToCheck,
};
use orbitid_identity::testing::{
    add_test_member, create_test_client_session, create_test_guest, create_test_organization,
    create_test_user, test_app_state,
};
use orbitid_identity::verifications::{
    check_code, consume_link, get_verification_by_token, issue_verification, magic_link_url,
    verification_json, IssueVerificationInput,
};

async fn insert_allow(state: &orbitid_core::AppState, identifier: &str) {
    let now_ms = now();
    sqlx::query(
        "INSERT INTO allowlist_identifiers (id, identifier, identifier_type, created_at, updated_at) \
         VALUES ($1,$2,'email_address',$3,$3)",
    )
    .bind(new_id(id_prefix::ALLOW))
    .bind(identifier)
    .bind(now_ms)
    .execute(&state.pool)
    .await
    .unwrap();
}

async fn insert_block(state: &orbitid_core::AppState, identifier: &str) {
    let now_ms = now();
    sqlx::query(
        "INSERT INTO blocklist_identifiers (id, identifier, identifier_type, created_at, updated_at) \
         VALUES ($1,$2,'email_address',$3,$3)",
    )
    .bind(new_id(id_prefix::BLOCK))
    .bind(identifier)
    .bind(now_ms)
    .execute(&state.pool)
    .await
    .unwrap();
}

async fn insert_invitation(
    state: &orbitid_core::AppState,
    email: &str,
    status: &str,
    expires_at: Option<i64>,
) -> (String, String) {
    let now_ms = now();
    let id = new_id(id_prefix::APP_INVITATION);
    let ticket = orbitid_core::crypto::random_token(24);
    sqlx::query(
        "INSERT INTO invitations (id, email, status, token_hash, public_metadata, expires_at, \
         created_at, updated_at) VALUES ($1,$2,$3,$4,'{}',$5,$6,$6)",
    )
    .bind(&id)
    .bind(email)
    .bind(status)
    .bind(orbitid_core::crypto::sha256(&ticket))
    .bind(expires_at)
    .bind(now_ms)
    .execute(&state.pool)
    .await
    .unwrap();
    (id, ticket)
}

#[tokio::test]
async fn public_mode_allows_every_identifier() {
    let app = test_app_state().await;
    let state = app.state();
    assert_eq!(
        assert_identifiers_allowed(
            state,
            &IdentifiersToCheck {
                emails: vec!["anyone@example.com".into()],
                ..Default::default()
            },
            false,
        )
        .await
        .unwrap(),
        Default::default()
    );
    assert_identifiers_allowed(
        state,
        &IdentifiersToCheck {
            emails: vec!["anyone@example.com".into()],
            phones: vec!["+15551234567".into()],
            invitation_ticket: None,
        },
        true,
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn restricted_mode_requires_allowlist_or_invitation() {
    let app = test_app_state().await;
    let state = app.state();
    state
        .settings
        .update(serde_json::json!({ "signUp": { "mode": "restricted" } }))
        .await
        .unwrap();
    let error = assert_identifiers_allowed(
        state,
        &IdentifiersToCheck {
            emails: vec!["blocked@example.com".into()],
            ..Default::default()
        },
        false,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, error_codes::SIGN_UP_RESTRICTED);

    insert_allow(state, "allowed@example.com").await;
    insert_allow(state, "*@partner.example").await;
    insert_allow(state, "+15551239999").await;
    // The admin route turns the allowlist restriction on when the first entry is
    // created; the service only consults the setting.
    state
        .settings
        .update(serde_json::json!({ "restrictions": { "allowlistEnabled": true } }))
        .await
        .unwrap();
    assert_identifiers_allowed(
        state,
        &IdentifiersToCheck {
            emails: vec!["Allowed@Example.com".into()],
            ..Default::default()
        },
        false,
    )
    .await
    .unwrap();
    assert_identifiers_allowed(
        state,
        &IdentifiersToCheck {
            emails: vec!["dev@partner.example".into()],
            ..Default::default()
        },
        false,
    )
    .await
    .unwrap();
    assert_identifiers_allowed(
        state,
        &IdentifiersToCheck {
            phones: vec!["+15551239999".into()],
            ..Default::default()
        },
        false,
    )
    .await
    .unwrap();
    assert!(assert_identifiers_allowed(
        state,
        &IdentifiersToCheck {
            emails: vec!["dev@other.example".into()],
            ..Default::default()
        },
        false,
    )
    .await
    .is_err());

    let (invitation_id, ticket) =
        insert_invitation(state, "ticket@example.com", "pending", None).await;
    let allowed = assert_identifiers_allowed(
        state,
        &IdentifiersToCheck {
            emails: vec!["ticket@example.com".into()],
            invitation_ticket: Some(ticket),
            ..Default::default()
        },
        false,
    )
    .await
    .unwrap();
    assert_eq!(
        allowed.invitation_id.as_deref(),
        Some(invitation_id.as_str())
    );
    // Validating does not consume.
    let status: String = sqlx::query_scalar("SELECT status FROM invitations WHERE id = $1")
        .bind(&invitation_id)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(status, "pending");
}

#[tokio::test]
async fn blocklist_applies_to_signup_and_signin() {
    let app = test_app_state().await;
    let state = app.state();
    insert_block(state, "bad@example.com").await;
    insert_block(state, "@spam.example").await;
    state
        .settings
        .update(serde_json::json!({ "restrictions": { "blocklistEnabled": true } }))
        .await
        .unwrap();
    for sign_in in [false, true] {
        let error = assert_identifiers_allowed(
            state,
            &IdentifiersToCheck {
                emails: vec!["BAD@example.com".into()],
                ..Default::default()
            },
            sign_in,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, error_codes::NOT_ALLOWED_ACCESS);
    }
    assert!(assert_identifiers_allowed(
        state,
        &IdentifiersToCheck {
            emails: vec!["user@spam.example".into()],
            ..Default::default()
        },
        false,
    )
    .await
    .is_err());
    state
        .settings
        .update(serde_json::json!({ "restrictions": { "blocklistEnabled": false } }))
        .await
        .unwrap();
    assert_identifiers_allowed(
        state,
        &IdentifiersToCheck {
            emails: vec!["bad@example.com".into()],
            ..Default::default()
        },
        false,
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn subaddresses_and_disposable_domains() {
    let app = test_app_state().await;
    let state = app.state();
    insert_block(state, "tagged@example.com").await;
    state
        .settings
        .update(serde_json::json!({ "restrictions": { "blocklistEnabled": true } }))
        .await
        .unwrap();
    assert_identifiers_allowed(
        state,
        &IdentifiersToCheck {
            emails: vec!["tagged+promo@example.com".into()],
            ..Default::default()
        },
        false,
    )
    .await
    .unwrap();
    state
        .settings
        .update(serde_json::json!({ "restrictions": { "blockEmailSubaddresses": true } }))
        .await
        .unwrap();
    assert!(assert_identifiers_allowed(
        state,
        &IdentifiersToCheck {
            emails: vec!["tagged+promo@example.com".into()],
            ..Default::default()
        },
        false,
    )
    .await
    .is_err());
    state
        .settings
        .update(serde_json::json!({ "restrictions": { "blockDisposableEmailDomains": true } }))
        .await
        .unwrap();
    assert!(assert_identifiers_allowed(
        state,
        &IdentifiersToCheck {
            emails: vec!["throwaway@mailinator.com".into()],
            ..Default::default()
        },
        false,
    )
    .await
    .is_err());
    assert_identifiers_allowed(
        state,
        &IdentifiersToCheck {
            emails: vec!["real@example.com".into()],
            ..Default::default()
        },
        false,
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn waitlist_mode_and_invitation_tickets() {
    let app = test_app_state().await;
    let state = app.state();
    state
        .settings
        .update(serde_json::json!({ "signUp": { "mode": "waitlist" } }))
        .await
        .unwrap();
    let error = assert_identifiers_allowed(
        state,
        &IdentifiersToCheck {
            emails: vec!["waiting@example.com".into()],
            ..Default::default()
        },
        false,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, error_codes::WAITLIST_MODE);

    let now_ms = now();
    sqlx::query(
        "INSERT INTO waitlist_entries (id, email, status, created_at, updated_at) \
         VALUES ($1,'pending@example.com','pending',$2,$2)",
    )
    .bind(new_id(id_prefix::WAITLIST))
    .bind(now_ms)
    .execute(&state.pool)
    .await
    .unwrap();
    assert!(assert_identifiers_allowed(
        state,
        &IdentifiersToCheck {
            emails: vec!["pending@example.com".into()],
            ..Default::default()
        },
        false,
    )
    .await
    .is_err());
    sqlx::query(
        "INSERT INTO waitlist_entries (id, email, status, created_at, updated_at) \
         VALUES ($1,'invited@example.com','invited',$2,$2)",
    )
    .bind(new_id(id_prefix::WAITLIST))
    .bind(now_ms)
    .execute(&state.pool)
    .await
    .unwrap();
    assert_identifiers_allowed(
        state,
        &IdentifiersToCheck {
            emails: vec!["invited@example.com".into()],
            ..Default::default()
        },
        false,
    )
    .await
    .unwrap();

    let (invitation_id, ticket) =
        insert_invitation(state, "ticket2@example.com", "pending", None).await;
    let grant = validate_ticket(state, &ticket).await.unwrap();
    assert_eq!(grant.kind, "invitation");
    assert_eq!(grant.invitation_id, invitation_id);
    assert!(redeem_ticket(state, "bogus").await.is_err());
    let expired =
        insert_invitation(state, "expired@example.com", "pending", Some(now_ms - 1)).await;
    let error = validate_ticket(state, &expired.1).await.unwrap_err();
    assert_eq!(error.code, error_codes::TICKET_EXPIRED);
    let revoked = insert_invitation(state, "revoked@example.com", "revoked", None).await;
    let error = validate_ticket(state, &revoked.1).await.unwrap_err();
    assert_eq!(error.code, error_codes::TICKET_INVALID);

    // Pending invitation lookup ignores expired rows.
    assert!(pending_invitation_for(state, "expired@example.com")
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        pending_invitation_for(state, "ticket2@example.com")
            .await
            .unwrap()
            .unwrap()
            .id,
        invitation_id
    );
}

#[tokio::test]
async fn accepting_an_invitation_completes_the_waitlist_entry() {
    let app = test_app_state().await;
    let state = app.state();
    let user = create_test_user(state, "accepted@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let (invitation_id, _) =
        insert_invitation(state, "accepted@example.com", "pending", None).await;
    sqlx::query(
        "INSERT INTO waitlist_entries (id, email, status, invitation_id, created_at, updated_at) \
         VALUES ($1,'accepted@example.com','invited',$2,$3,$3)",
    )
    .bind(new_id(id_prefix::WAITLIST))
    .bind(&invitation_id)
    .bind(now())
    .execute(&state.pool)
    .await
    .unwrap();
    mark_invitation_accepted(state, &invitation_id, &user.user.id)
        .await
        .unwrap();
    let status: String = sqlx::query_scalar("SELECT status FROM waitlist_entries")
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(status, "completed");
    let event: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM webhook_events WHERE type = 'invitation.accepted'",
    )
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert_eq!(event, 1);
    // Idempotent.
    mark_invitation_accepted(state, &invitation_id, &user.user.id)
        .await
        .unwrap();
}

#[tokio::test]
async fn guest_cleanup_keeps_live_sessions_until_they_end() {
    let app = test_app_state().await;
    let state = app.state();
    state
        .settings
        .update(
            serde_json::json!({ "anonymous": { "enabled": true, "retentionSeconds": 2592000 } }),
        )
        .await
        .unwrap();
    let active = create_test_guest(state).await.unwrap();
    let abandoned = create_test_guest(state).await.unwrap();
    create_test_client_session(state, &active.id).await.unwrap();
    let guest_ids = vec![active.id.clone(), abandoned.id.clone()];
    sqlx::query(
        "INSERT INTO uploads (file, bucket, owner_id, content_type, bytes, created_at) \
         VALUES ('usr_guest_avatar.png', 'avatar', $1, 'image/png', 'png', $2)",
    )
    .bind(&abandoned.id)
    .bind(now())
    .execute(&state.pool)
    .await
    .unwrap();
    sqlx::query("UPDATE users SET last_active_at = $1 WHERE id = ANY($2)")
        .bind(now() - 60 * 86_400_000)
        .bind(guest_ids)
        .execute(&state.pool)
        .await
        .unwrap();
    let stale = stale_anonymous_user_ids(state, None).await.unwrap();
    assert_eq!(stale, vec![abandoned.id.clone()]);
    assert_eq!(cleanup_anonymous_users(state, None, None).await.unwrap(), 1);
    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE id = $1")
        .bind(&active.id)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(remaining, 1);
    let avatar_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM uploads WHERE owner_id = $1")
        .bind(&abandoned.id)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(
        avatar_rows, 0,
        "the guest avatar row is deleted with the user"
    );

    let session = sqlx::query_as::<_, orbitid_core::models::SessionRow>(
        "SELECT * FROM sessions WHERE user_id = $1",
    )
    .bind(&active.id)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    orbitid_identity::sessions::end_session(state, &session, "ended")
        .await
        .unwrap();
    assert_eq!(
        stale_anonymous_user_ids(state, None).await.unwrap(),
        vec![active.id.clone()]
    );
    assert_eq!(cleanup_anonymous_users(state, None, None).await.unwrap(), 1);
}

/// The server entry point calls `install`, which must own the guest-cleanup
/// worker; short-lived tools call `install_without_workers` instead.
#[tokio::test]
async fn install_starts_the_anonymous_cleanup_worker_and_shutdown_stops_it() {
    let ctx = orbitid_core::testing::test_state().await;
    let handles = orbitid_identity::install(&ctx.state).await.unwrap();
    assert!(handles.anonymous_cleanup.is_some());
    handles.shutdown();
    // Stopping is idempotent, as at the end of a graceful shutdown.
    handles.shutdown();

    let handles = orbitid_identity::install_without_workers(&ctx.state)
        .await
        .unwrap();
    assert!(handles.anonymous_cleanup.is_none());
}

#[tokio::test]
async fn cleanup_is_disabled_by_default() {
    let app = test_app_state().await;
    let state = app.state();
    assert_eq!(state.settings.get().anonymous.retention_seconds, 0);
    let guest = create_test_guest(state).await.unwrap();
    sqlx::query("UPDATE users SET last_active_at = $1 WHERE id = $2")
        .bind(now() - 3_650 * 86_400_000)
        .bind(&guest.id)
        .execute(&state.pool)
        .await
        .unwrap();
    assert!(stale_anonymous_user_ids(state, None)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(cleanup_anonymous_users(state, None, None).await.unwrap(), 0);
    assert!(orbitid_identity::users::get_user_by_id(state, &guest.id)
        .await
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn verification_attempts_are_counted_atomically() {
    let app = test_app_state().await;
    let state = app.state();
    let issued = issue_verification(
        state,
        IssueVerificationInput {
            max_attempts: Some(5),
            ..IssueVerificationInput::new(
                "sign_in_first_factor",
                "email_code",
                "race@example.com",
                "sia_concurrency",
                600,
            )
        },
    )
    .await
    .unwrap();
    let code = issued.code.clone().unwrap();
    let wrong = if code == "000000" { "111111" } else { "000000" };
    let mut tasks = Vec::new();
    for _ in 0..12 {
        let state = state.clone();
        let row = issued.row.clone();
        let wrong = wrong.to_string();
        tasks.push(tokio::spawn(async move {
            check_code(&state, Some(&row), Some(&wrong)).await
        }));
    }
    for task in tasks {
        task.await.unwrap().unwrap_err();
    }
    let row = orbitid_identity::verifications::get_verification_by_id(state, &issued.row.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.attempts, 5);
    let error = check_code(state, Some(&row), Some(&code))
        .await
        .unwrap_err();
    assert_eq!(error.code, error_codes::TOO_MANY_ATTEMPTS);
}

#[tokio::test]
async fn links_are_single_use_and_magic_link_url_is_absolute() {
    let app = test_app_state().await;
    let state = app.state();
    let issued = issue_verification(
        state,
        IssueVerificationInput::new(
            "sign_in_first_factor",
            "email_link",
            "link@example.com",
            "sia_link",
            600,
        ),
    )
    .await
    .unwrap();
    assert!(issued.code.is_none());
    let token = issued.token.unwrap();
    let found = get_verification_by_token(state, &token)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(found.id, issued.row.id);
    let consumed = consume_link(state, &found).await.unwrap();
    assert!(consumed.consumed_at.is_some());
    // A parallel/second click is idempotent.
    let again = consume_link(state, &found).await.unwrap();
    assert_eq!(again.id, issued.row.id);
    let url = magic_link_url(
        state,
        &token,
        &[("redirect_url", Some("http://localhost:3000/"))],
    );
    assert!(url.starts_with("http://localhost:4000/v1/verify?token="));
    assert!(url.contains("redirect_url=http%3A%2F%2Flocalhost%3A3000%2F"));
}

#[tokio::test]
async fn verification_json_reports_every_status() {
    let app = test_app_state().await;
    let state = app.state();
    let issued = issue_verification(
        state,
        IssueVerificationInput::new(
            "add_email",
            "email_code",
            "json@example.com",
            "user_json",
            600,
        ),
    )
    .await
    .unwrap();
    let pending = verification_json(Some(&issued.row), None).unwrap();
    assert_eq!(pending.status, VerificationStatus::Unverified);
    assert_eq!(pending.attempts, Some(0));
    let verified = check_code(state, Some(&issued.row), issued.code.as_deref())
        .await
        .unwrap();
    assert_eq!(
        verification_json(Some(&verified), None).unwrap().status,
        VerificationStatus::Verified
    );
    let mut expired = issued.row.clone();
    expired.verified_at = None;
    expired.expires_at = now() - 1;
    assert_eq!(
        verification_json(Some(&expired), None).unwrap().status,
        VerificationStatus::Expired
    );
    let mut failed = issued.row.clone();
    failed.max_attempts = 1;
    failed.attempts = 1;
    failed.expires_at = now() + 1000;
    assert_eq!(
        verification_json(Some(&failed), None).unwrap().status,
        VerificationStatus::Failed
    );
    let mut transferable = issued.row;
    transferable.data = Some(sqlx::types::Json(
        serde_json::json!({ "transferable": true }),
    ));
    assert_eq!(
        verification_json(Some(&transferable), Some("oauth_google"))
            .unwrap()
            .status,
        VerificationStatus::Transferable
    );
}

/// Guest cleanup must run the organization lifecycle *before* the user delete.
/// The old order deleted the user first, so the FK cascade had already removed
/// the memberships when `on_user_deleted` ran: no last-admin promotion, no
/// `organizationMembership.deleted` event and no organization deletion.
#[tokio::test]
async fn guest_cleanup_promotes_or_deletes_organizations_before_the_delete() {
    let app = test_app_state().await;
    let state = app.state();
    state
        .settings
        .update(
            serde_json::json!({ "anonymous": { "enabled": true, "retentionSeconds": 2_592_000 } }),
        )
        .await
        .unwrap();
    let guest = create_test_guest(state).await.unwrap();
    let heir = create_test_user(state, "heir@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let shared = create_test_organization(state, "Guest Shared Org", None, &guest.id)
        .await
        .unwrap();
    add_test_member(state, &shared.id, &heir.user.id, "org:member")
        .await
        .unwrap();
    let guest_logo = format!("{}_logo.png", guest.id);
    sqlx::query(
        "INSERT INTO uploads (file, bucket, owner_id, content_type, bytes, created_at) \
         VALUES ($1, 'org_logo', $2, 'image/png', 'png', $3)",
    )
    .bind(&guest_logo)
    .bind(&guest.id)
    .bind(now())
    .execute(&state.pool)
    .await
    .unwrap();
    sqlx::query("UPDATE organizations SET image_url = $1 WHERE id = $2")
        .bind(format!(
            "http://localhost:4000/v1/client/organization_logos/{guest_logo}"
        ))
        .bind(&shared.id)
        .execute(&state.pool)
        .await
        .unwrap();

    // A second guest owns an organization with no other member.
    let lone = create_test_guest(state).await.unwrap();
    let doomed = create_test_organization(state, "Guest Lone Org", None, &lone.id)
        .await
        .unwrap();
    let lone_logo = format!("{}_logo.png", lone.id);
    sqlx::query(
        "INSERT INTO uploads (file, bucket, owner_id, content_type, bytes, created_at) \
         VALUES ($1, 'org_logo', $2, 'image/png', 'png', $3)",
    )
    .bind(&lone_logo)
    .bind(&lone.id)
    .bind(now())
    .execute(&state.pool)
    .await
    .unwrap();
    sqlx::query("UPDATE organizations SET image_url = $1 WHERE id = $2")
        .bind(format!(
            "http://localhost:4000/v1/client/organization_logos/{lone_logo}"
        ))
        .bind(&doomed.id)
        .execute(&state.pool)
        .await
        .unwrap();

    for id in [&guest.id, &lone.id] {
        sqlx::query("UPDATE users SET last_active_at = $1 WHERE id = $2")
            .bind(now() - 60 * 86_400_000)
            .bind(id)
            .execute(&state.pool)
            .await
            .unwrap();
    }
    assert_eq!(cleanup_anonymous_users(state, None, None).await.unwrap(), 2);

    // The shared organization survives and the remaining member was promoted.
    let remaining: Vec<String> = sqlx::query_scalar(
        "SELECT user_id FROM organization_memberships WHERE organization_id = $1 ORDER BY id",
    )
    .bind(&shared.id)
    .fetch_all(&state.pool)
    .await
    .unwrap();
    assert_eq!(remaining, vec![heir.user.id.clone()]);
    let deleted_events: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM webhook_events WHERE type = 'organizationMembership.deleted'",
    )
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert_eq!(
        deleted_events, 2,
        "both guests' memberships emit organizationMembership.deleted"
    );
    let updated_events: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM webhook_events WHERE type = 'organizationMembership.updated'",
    )
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert_eq!(updated_events, 1, "last-admin promotion event");

    // The organization without another member is deleted, with its logo.
    let doomed_left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM organizations WHERE id = $1")
        .bind(&doomed.id)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(doomed_left, 0);
    let org_deleted_events: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM webhook_events WHERE type = 'organization.deleted'",
    )
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert_eq!(org_deleted_events, 1);
    let logo_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM uploads WHERE file = $1")
        .bind(&lone_logo)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(logo_rows, 0, "the deleted organization's logo is removed");
}
