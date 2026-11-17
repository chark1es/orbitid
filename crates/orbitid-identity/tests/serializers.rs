use orbitid_core::http::now;
use orbitid_core::resources::Metadata;
use orbitid_identity::serializers::{
    public_user_data, serialize_email, serialize_external_account, serialize_membership,
    serialize_memberships, serialize_organization, serialize_organizations, serialize_passkey,
    serialize_phone, serialize_session, serialize_sessions, serialize_trusted_device,
    serialize_user, serialize_users, SessionSerializeOptions, UserSerializeOptions,
};
use orbitid_identity::testing::{
    add_test_member, create_test_client_session, create_test_organization, create_test_user,
    test_app_state,
};
use serde_json::json;

#[tokio::test]
async fn identification_serializers_match_the_wire_shape() {
    let app = test_app_state().await;
    let state = app.state();
    let user = create_test_user(state, "shape@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let email = sqlx::query_as::<_, orbitid_core::models::EmailAddressRow>(
        "SELECT * FROM email_addresses WHERE user_id = $1",
    )
    .bind(&user.user.id)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    let json = serde_json::to_value(serialize_email(&email)).unwrap();
    assert_eq!(json["object"], "email_address");
    assert_eq!(json["email_address"], "shape@example.com");
    assert_eq!(json["verification"]["status"], "verified");
    assert_eq!(json["verification"]["strategy"], "email_code");
    assert!(json["verification"]["attempts"].is_null());
    assert!(json["verification"]["expire_at"].is_null());
    assert_eq!(json["linked_to"], json!([]));
    assert_eq!(json["reserved"], false);

    let phone = orbitid_core::models::PhoneNumberRow {
        id: "idn_p_test".into(),
        user_id: Some(user.user.id.clone()),
        phone: "+15551234567".into(),
        verified: false,
        verified_at: None,
        reserved_for_second_factor: true,
        default_second_factor: false,
        created_at: 1,
        updated_at: 2,
    };
    let json = serde_json::to_value(serialize_phone(&phone)).unwrap();
    assert_eq!(json["object"], "phone_number");
    assert_eq!(json["reserved_for_second_factor"], true);
    assert_eq!(json["verification"]["status"], "unverified");
    assert_eq!(json["verification"]["attempts"], 0);

    let external = orbitid_core::models::ExternalAccountRow {
        id: "eac_test".into(),
        user_id: Some(user.user.id.clone()),
        provider: "google".into(),
        provider_user_id: "g-1".into(),
        email_address: "shape@example.com".into(),
        first_name: "Grace".into(),
        last_name: "Hopper".into(),
        username: None,
        image_url: Some("https://example.com/a.png".into()),
        approved_scopes: "openid email".into(),
        access_token_enc: None,
        refresh_token_enc: None,
        token_expires_at: None,
        public_metadata: sqlx::types::Json(Metadata::new()),
        created_at: 1,
        updated_at: 2,
    };
    let json = serde_json::to_value(serialize_external_account(&external)).unwrap();
    assert_eq!(json["object"], "external_account");
    assert_eq!(json["identification_id"], "eac_test");
    assert_eq!(json["avatar_url"], "https://example.com/a.png");
    assert!(json["label"].is_null());
    assert_eq!(json["verification"]["strategy"], "from_oauth_google");

    let passkey = orbitid_core::models::PasskeyRow {
        id: "pkey_test".into(),
        user_id: user.user.id.clone(),
        name: "Laptop".into(),
        credential_id: "cred".into(),
        public_key: "pk".into(),
        counter: 0,
        transports: None,
        device_type: None,
        backed_up: false,
        last_used_at: None,
        created_at: 1,
        updated_at: 2,
    };
    let json = serde_json::to_value(serialize_passkey(&passkey)).unwrap();
    assert_eq!(json["object"], "passkey");
    assert_eq!(json["verification"]["status"], "verified");

    let device = orbitid_core::models::TrustedDeviceRow {
        id: "tdev_test".into(),
        user_id: user.user.id.clone(),
        token_hash: "secret-hash".into(),
        label: Some("Safari on macOS".into()),
        user_agent: None,
        ip_address: None,
        expires_at: 10,
        last_used_at: None,
        revoked_at: None,
        created_at: 1,
        updated_at: 2,
    };
    let json = serde_json::to_value(serialize_trusted_device(&device)).unwrap();
    assert!(json.get("token_hash").is_none());
    assert_eq!(json["object"], "trusted_device");
}

#[tokio::test]
async fn user_serialization_includes_relations_and_roles() {
    let app = test_app_state().await;
    let state = app.state();
    let mut public = Metadata::new();
    public.insert("plan".into(), json!("pro"));
    let mut private = Metadata::new();
    private.insert("secret".into(), json!("value"));
    let user = orbitid_identity::users::create_user(
        state,
        &orbitid_identity::users::CreateUserInput {
            email: Some("full@example.com".into()),
            email_verified: true,
            public_metadata: Some(public),
            private_metadata: Some(private),
            silent: true,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let json = serialize_user(state, &user, UserSerializeOptions::default())
        .await
        .unwrap();
    let value = serde_json::to_value(&json).unwrap();
    assert_eq!(value["object"], "user");
    assert_eq!(value["is_anonymous"], false);
    assert_eq!(value["password_enabled"], false);
    assert_eq!(value["public_metadata"]["plan"], "pro");
    assert!(value.get("private_metadata").is_none());
    assert!(value["image_url"]
        .as_str()
        .unwrap()
        .starts_with("data:image/svg+xml;utf8,"));
    assert_eq!(value["email_addresses"].as_array().unwrap().len(), 1);
    assert_eq!(value["verification_attempts_remaining"], 100);
    assert_eq!(value["roles"], json!([]));

    let backend = serialize_user(state, &user, UserSerializeOptions { backend: true })
        .await
        .unwrap();
    let value = serde_json::to_value(&backend).unwrap();
    assert_eq!(value["private_metadata"]["secret"], "value");

    let public = public_user_data(state, &user).await.unwrap();
    assert_eq!(public.identifier, "full@example.com");
    assert_eq!(public.user_id, user.id);
}

#[tokio::test]
async fn locked_user_math_and_second_factors() {
    let app = test_app_state().await;
    let state = app.state();
    let user = create_test_user(state, "locked@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    sqlx::query("UPDATE users SET locked = true, lockout_expires_at = $1 WHERE id = $2")
        .bind(now() + 60_000)
        .bind(&user.user.id)
        .execute(&state.pool)
        .await
        .unwrap();
    let fresh = orbitid_identity::users::require_user(state, &user.user.id)
        .await
        .unwrap();
    let value = serde_json::to_value(
        serialize_user(state, &fresh, UserSerializeOptions::default())
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(value["locked"], true);
    assert!(value["lockout_expires_in_seconds"].as_i64().unwrap() >= 59);

    // A lockout that already elapsed reads as unlocked.
    sqlx::query("UPDATE users SET lockout_expires_at = $1 WHERE id = $2")
        .bind(now() - 1)
        .bind(&user.user.id)
        .execute(&state.pool)
        .await
        .unwrap();
    let expired = orbitid_identity::users::require_user(state, &user.user.id)
        .await
        .unwrap();
    let value = serde_json::to_value(
        serialize_user(state, &expired, UserSerializeOptions::default())
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(value["locked"], false);
    assert!(value["lockout_expires_in_seconds"].is_null());

    // A verified second-factor phone turns two-factor on.
    sqlx::query(
        "INSERT INTO phone_numbers (id, user_id, phone, verified, verified_at, \
         reserved_for_second_factor, created_at, updated_at) \
         VALUES ('idn_p_2fa', $1, '+15551230000', true, $2, true, $2, $2)",
    )
    .bind(&user.user.id)
    .bind(now())
    .execute(&state.pool)
    .await
    .unwrap();
    let with_phone = orbitid_identity::users::require_user(state, &user.user.id)
        .await
        .unwrap();
    let value = serde_json::to_value(
        serialize_user(state, &with_phone, UserSerializeOptions::default())
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(value["two_factor_enabled"], true);
}

#[tokio::test]
async fn session_serialization_matches_activity_and_factor_ages() {
    let app = test_app_state().await;
    let state = app.state();
    let user = create_test_user(state, "session-shape@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let auth = create_test_client_session(state, &user.user.id)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE sessions SET user_agent = 'Mozilla/5.0 (X11; Linux) Chrome/126.0 Safari/537.36', \
         ip = '127.0.0.1', actor = $1, auth_method = 'password' WHERE id = $2",
    )
    .bind(sqlx::types::Json(json!({ "sub": "admin_42" })))
    .bind(&auth.session.id)
    .execute(&state.pool)
    .await
    .unwrap();
    let row = orbitid_identity::sessions::get_session(state, &auth.session.id)
        .await
        .unwrap()
        .unwrap();
    let json = serialize_session(
        state,
        &row,
        SessionSerializeOptions {
            with_user: true,
            last_token: Some("jwt-value".into()),
        },
    )
    .await
    .unwrap();
    let value = serde_json::to_value(&json).unwrap();
    assert_eq!(value["object"], "session");
    assert_eq!(value["status"], "active");
    assert_eq!(value["actor"]["sub"], "admin_42");
    assert_eq!(value["factor_verification_age"][0], 0);
    assert_eq!(value["factor_verification_age"][1], -1);
    assert_eq!(value["sign_in_method"], "password");
    assert_eq!(value["last_active_token"]["jwt"], "jwt-value");
    assert_eq!(value["latest_activity"]["browser_name"], "Safari");
    assert_eq!(value["latest_activity"]["browser_version"], "537.36");
    assert_eq!(value["latest_activity"]["is_mobile"], false);
    assert_eq!(value["latest_activity"]["ip_address"], "127.0.0.1");
    assert_eq!(value["user"]["id"], user.user.id);
    assert!(value
        .get("second_factor_skipped_by_trusted_device")
        .is_none());
}

#[tokio::test]
async fn batch_serializers_match_single_row_output() {
    let app = test_app_state().await;
    let state = app.state();
    let owner = create_test_user(state, "owner-batch@acme.test", "Sup3r-secret!")
        .await
        .unwrap();
    let member = create_test_user(state, "member-batch@acme.test", "Sup3r-secret!")
        .await
        .unwrap();
    let org = create_test_organization(state, "Batch Inc", None, &owner.user.id)
        .await
        .unwrap();
    add_test_member(state, &org.id, &member.user.id, "org:member")
        .await
        .unwrap();

    let users = vec![owner.user.clone(), member.user.clone()];
    let batched = serialize_users(state, &users, UserSerializeOptions::default())
        .await
        .unwrap();
    for (index, user) in users.iter().enumerate() {
        let single = serialize_user(state, user, UserSerializeOptions::default())
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(&batched[index]).unwrap(),
            serde_json::to_value(&single).unwrap()
        );
    }

    let orgs = vec![org.clone()];
    let batched = serialize_organizations(state, &orgs, false, true)
        .await
        .unwrap();
    let single = serialize_organization(state, &org, false, true)
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(&batched[0]).unwrap(),
        serde_json::to_value(&single).unwrap()
    );
    assert_eq!(single.members_count, Some(2));

    let memberships = sqlx::query_as::<_, orbitid_core::models::OrganizationMembershipRow>(
        "SELECT * FROM organization_memberships WHERE organization_id = $1 ORDER BY created_at",
    )
    .bind(&org.id)
    .fetch_all(&state.pool)
    .await
    .unwrap();
    let batched = serialize_memberships(state, &memberships, true)
        .await
        .unwrap();
    for (index, row) in memberships.iter().enumerate() {
        let single = serialize_membership(state, row, true).await.unwrap();
        assert_eq!(
            serde_json::to_value(&batched[index]).unwrap(),
            serde_json::to_value(&single).unwrap()
        );
    }
    let admin = batched.iter().find(|row| row.role == "org:admin").unwrap();
    assert_eq!(admin.role_name, "Admin");
    assert!(admin
        .permissions
        .contains(&"org:sys_profile:manage".to_string()));

    let sessions = vec![auth_session(state, &owner.user.id).await];
    let batched = serialize_sessions(state, &sessions, true, &Default::default())
        .await
        .unwrap();
    let single = serialize_session(
        state,
        &sessions[0],
        SessionSerializeOptions {
            with_user: true,
            last_token: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        serde_json::to_value(&batched[0]).unwrap(),
        serde_json::to_value(&single).unwrap()
    );
}

async fn auth_session(
    state: &orbitid_core::AppState,
    user_id: &str,
) -> orbitid_core::models::SessionRow {
    create_test_client_session(state, user_id)
        .await
        .unwrap()
        .session
}
