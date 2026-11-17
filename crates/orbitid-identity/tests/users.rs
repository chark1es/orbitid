use orbitid_core::error::error_codes;
use orbitid_core::http::now;
use orbitid_identity::testing::{
    create_test_client_session, create_test_guest, create_test_user, test_app_state,
};
use orbitid_identity::users::{
    assert_required_identifier_remains, assert_required_profile_field, count_identifications,
    create_user, delete_email_address, delete_user, detect_identifier_type, get_user_by_id,
    get_user_by_identifier, is_valid_email, normalize_phone, record_failed_attempt,
    reset_failed_attempts, upgrade_anonymous_user, CreateUserInput, IdentifierType, ProfileField,
};

#[tokio::test]
async fn create_user_links_a_verified_primary_email() {
    let app = test_app_state().await;
    let state = app.state();
    let user = create_test_user(state, "Verified@Example.com", "Sup3r-secret!")
        .await
        .unwrap();
    assert_eq!(user.email, "verified@example.com");
    let row = get_user_by_id(state, &user.user.id).await.unwrap().unwrap();
    let email = sqlx::query_as::<_, orbitid_core::models::EmailAddressRow>(
        "SELECT * FROM email_addresses WHERE user_id = $1",
    )
    .bind(&row.id)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert!(email.verified);
    assert_eq!(
        row.primary_email_address_id.as_deref(),
        Some(email.id.as_str())
    );
    assert!(row.password_hash.is_some());
    assert!(!row.is_anonymous);
}

#[tokio::test]
async fn duplicate_verified_email_is_rejected() {
    let app = test_app_state().await;
    let state = app.state();
    create_test_user(state, "taken@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let error = create_user(
        state,
        &CreateUserInput {
            email: Some("TAKEN@example.com".into()),
            email_verified: true,
            silent: true,
            ..Default::default()
        },
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, error_codes::FORM_IDENTIFIER_EXISTS);
}

#[tokio::test]
async fn verifying_an_address_purges_other_unverified_claims() {
    let app = test_app_state().await;
    let state = app.state();
    let squatter = create_user(
        state,
        &CreateUserInput {
            email: Some("claim@example.com".into()),
            silent: true,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let owner = create_user(
        state,
        &CreateUserInput {
            email: Some("claim@example.com".into()),
            email_verified: true,
            silent: true,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let squatter_after = get_user_by_id(state, &squatter.id).await.unwrap().unwrap();
    assert!(squatter_after.primary_email_address_id.is_none());
    let remaining: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM email_addresses WHERE email = 'claim@example.com' AND user_id = $1",
    )
    .bind(&squatter.id)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert_eq!(remaining, 0);
    let owner_email: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM email_addresses WHERE email = 'claim@example.com' AND verified = true AND user_id = $1",
    )
    .bind(&owner.id)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert_eq!(owner_email, 1);
}

#[tokio::test]
async fn last_identification_cannot_be_removed() {
    let app = test_app_state().await;
    let state = app.state();
    let user = create_test_user(state, "last@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let row = get_user_by_id(state, &user.user.id).await.unwrap().unwrap();
    assert_eq!(count_identifications(state, &row.id).await.unwrap(), 1);
    let error = delete_email_address(
        state,
        &row.id,
        row.primary_email_address_id.as_deref().unwrap(),
    )
    .await
    .unwrap_err();
    assert_eq!(
        error.code,
        error_codes::LAST_IDENTIFICATION_CANNOT_BE_REMOVED
    );
}

#[tokio::test]
async fn required_identifier_stays_even_with_another_identification() {
    let app = test_app_state().await;
    let state = app.state();
    state
        .settings
        .update(serde_json::json!({
            "attributes": { "emailAddress": { "enabled": true, "required": true } }
        }))
        .await
        .unwrap();
    let user = create_user(
        state,
        &CreateUserInput {
            email: Some("required@example.com".into()),
            phone: Some("+15551234567".into()),
            email_verified: true,
            phone_verified: true,
            silent: true,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let email: String = sqlx::query_scalar("SELECT id FROM email_addresses WHERE user_id = $1")
        .bind(&user.id)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    let error = delete_email_address(state, &user.id, &email)
        .await
        .unwrap_err();
    assert_eq!(error.code, error_codes::FORM_PARAM_VALUE_INVALID);
    assert_eq!(
        error.meta.unwrap()["param_name"],
        serde_json::json!("email_address")
    );
    assert_eq!(count_identifications(state, &user.id).await.unwrap(), 2);
}

#[tokio::test]
async fn required_profile_field_refuses_clearing() {
    let app = test_app_state().await;
    let state = app.state();
    state
        .settings
        .update(serde_json::json!({
            "attributes": { "firstName": { "enabled": true, "required": true } }
        }))
        .await
        .unwrap();
    assert!(assert_required_profile_field(state, ProfileField::FirstName, None).is_ok());
    assert!(
        assert_required_profile_field(state, ProfileField::FirstName, Some(Some("Grace"))).is_ok()
    );
    let error = assert_required_profile_field(state, ProfileField::FirstName, Some(Some("  ")))
        .unwrap_err();
    assert_eq!(error.code, error_codes::FORM_PARAM_MISSING);
}

#[tokio::test]
async fn guest_upgrades_only_with_a_verified_identifier() {
    let app = test_app_state().await;
    let state = app.state();
    let guest = create_test_guest(state).await.unwrap();
    assert!(guest.is_anonymous);
    // A password alone is not enough.
    sqlx::query("UPDATE users SET password_hash = 'x' WHERE id = $1")
        .bind(&guest.id)
        .execute(&state.pool)
        .await
        .unwrap();
    let unchanged = upgrade_anonymous_user(state, &guest.id)
        .await
        .unwrap()
        .unwrap();
    assert!(unchanged.is_anonymous);

    sqlx::query(
        "INSERT INTO email_addresses (id, user_id, email, verified, verified_at, created_at, updated_at) \
         VALUES ('idn_e_guest', $1, 'guest@example.com', true, $2, $2, $2)",
    )
    .bind(&guest.id)
    .bind(now())
    .execute(&state.pool)
    .await
    .unwrap();
    let upgraded = upgrade_anonymous_user(state, &guest.id)
        .await
        .unwrap()
        .unwrap();
    assert!(!upgraded.is_anonymous);
}

#[tokio::test]
async fn deleting_a_user_removes_sessions_and_memberships() {
    let app = test_app_state().await;
    let state = app.state();
    let owner = create_test_user(state, "owner-del@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let member = create_test_user(state, "member-del@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let org = orbitid_identity::testing::create_test_organization(
        state,
        "Delete Co",
        None,
        &owner.user.id,
    )
    .await
    .unwrap();
    orbitid_identity::testing::add_test_member(state, &org.id, &member.user.id, "org:member")
        .await
        .unwrap();
    create_test_client_session(state, &member.user.id)
        .await
        .unwrap();
    delete_user(state, &member.user.id).await.unwrap();
    assert!(get_user_by_id(state, &member.user.id)
        .await
        .unwrap()
        .is_none());
    let sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE user_id = $1")
        .bind(&member.user.id)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(sessions, 0);
    let memberships: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM organization_memberships WHERE user_id = $1")
            .bind(&member.user.id)
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert_eq!(memberships, 0);
    let events: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM webhook_events WHERE type = 'user.deleted'")
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert_eq!(events, 1);
}

#[tokio::test]
async fn parallel_failed_attempts_lock_the_account() {
    let app = test_app_state().await;
    let state = app.state();
    state
        .settings
        .update(serde_json::json!({ "mfa": { "maxAttempts": 3 } }))
        .await
        .unwrap();
    let user = create_test_user(state, "lock@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let mut tasks = Vec::new();
    for _ in 0..10 {
        let state = state.clone();
        let user_id = user.user.id.clone();
        tasks.push(tokio::spawn(async move {
            record_failed_attempt(&state, &user_id).await
        }));
    }
    for task in tasks {
        task.await.unwrap().unwrap();
    }
    let row = get_user_by_id(state, &user.user.id).await.unwrap().unwrap();
    assert!(row.locked);
    assert!(row.lockout_expires_at.unwrap() > now() - 1_000);

    reset_failed_attempts(state, &user.user.id).await.unwrap();
    let row = get_user_by_id(state, &user.user.id).await.unwrap().unwrap();
    assert!(!row.locked);
    assert_eq!(row.failed_attempts, 0);
}

#[tokio::test]
async fn identifier_helpers_match_the_wire_contract() {
    assert_eq!(
        detect_identifier_type("person@example.com"),
        IdentifierType::EmailAddress
    );
    assert_eq!(
        detect_identifier_type("+1 (555) 123-4567"),
        IdentifierType::PhoneNumber
    );
    assert_eq!(detect_identifier_type("ghopper"), IdentifierType::Username);
    assert!(is_valid_email("a@b.co"));
    assert!(!is_valid_email("a@b"));
    assert_eq!(normalize_phone("(555) 123-4567").unwrap(), "+15551234567");
    assert_eq!(normalize_phone("+44 7700 900123").unwrap(), "+447700900123");
    assert!(normalize_phone("123").is_err());
}

#[tokio::test]
async fn finds_users_by_any_identifier() {
    let app = test_app_state().await;
    let state = app.state();
    let user = create_test_user(state, "lookup@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    sqlx::query("UPDATE users SET username = 'lookup', username_lower = 'lookup' WHERE id = $1")
        .bind(&user.user.id)
        .execute(&state.pool)
        .await
        .unwrap();
    let (by_email, kind) = get_user_by_identifier(state, "Lookup@Example.com")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(kind, IdentifierType::EmailAddress);
    assert_eq!(by_email.id, user.user.id);
    let (by_username, kind) = get_user_by_identifier(state, "LOOKUP")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(kind, IdentifierType::Username);
    assert_eq!(by_username.id, user.user.id);
    assert!(get_user_by_identifier(state, "missing@example.com")
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn admin_user_lookup_has_backend_404_shape() {
    let app = test_app_state().await;
    let state = app.state();
    let error = orbitid_identity::admin::get_user_or_throw(state, "user_missing")
        .await
        .unwrap_err();
    assert_eq!(error.code, error_codes::RESOURCE_NOT_FOUND);
    assert_eq!(error.status.as_u16(), 404);
    assert_eq!(
        error.meta.unwrap()["param_name"],
        serde_json::json!("user_id")
    );
}

#[tokio::test]
async fn assert_required_identifier_helper_is_a_noop_when_disabled() {
    let app = test_app_state().await;
    let state = app.state();
    state
        .settings
        .update(serde_json::json!({
            "attributes": { "emailAddress": { "enabled": false, "required": false } }
        }))
        .await
        .unwrap();
    let user = create_test_user(state, "noop@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    assert_required_identifier_remains(state, &user.user.id, "email_address")
        .await
        .unwrap();
}
