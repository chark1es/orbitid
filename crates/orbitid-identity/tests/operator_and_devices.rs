use axum::http::{HeaderMap, HeaderValue};
use orbitid_core::config::EnvOverrides;
use orbitid_core::http::now;
use orbitid_core::state::AppState;
use orbitid_identity::operator_session::{
    clear_operator_cookie, find_operator_session, issue_operator_session, key_fingerprint,
    operator_cookie_origin_allowed, revoke_all_operator_sessions, revoke_operator_session,
    set_operator_cookie, sweep_operator_sessions, OPERATOR_SESSION_TTL_MS,
};
use orbitid_identity::testing::{
    create_test_user, enable_trusted_devices, test_app_state, test_app_state_with,
};
use orbitid_identity::trusted_devices::{
    clear_trusted_device_cookie, issue_trusted_device, list_trusted_devices,
    read_trusted_device_token, redeem_trusted_device, revoke_all_trusted_devices,
    revoke_trusted_device, set_trusted_device_cookie, trusted_device_label, trusted_device_valid,
};

fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
    let mut headers = HeaderMap::new();
    for (name, value) in pairs {
        headers.insert(
            name.parse::<axum::http::header::HeaderName>().unwrap(),
            HeaderValue::from_str(value).unwrap(),
        );
    }
    headers
}

fn cookie_value(headers: &HeaderMap) -> String {
    headers
        .get("set-cookie")
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .split_once('=')
        .unwrap()
        .1
        .to_string()
}

#[tokio::test]
async fn key_fingerprint_is_stable_and_key_specific() {
    let a = key_fingerprint("sk_test_one");
    assert_eq!(a, key_fingerprint("sk_test_one"));
    assert_ne!(a, key_fingerprint("sk_test_two"));
    assert!(!a.contains("sk_test_one"));
}

#[tokio::test]
async fn operator_session_lifecycle() {
    let app = test_app_state().await;
    let state = app.state();
    let (row, token) = issue_operator_session(
        state,
        Some("Mozilla/5.0 (Windows NT 10.0) Chrome/126.0"),
        Some("127.0.0.1"),
    )
    .await
    .unwrap();
    assert!(row.id.starts_with("osess_"));
    assert_eq!(row.token_hash, orbitid_core::crypto::sha256(&token));
    assert!(!row.token_hash.contains(&token));
    assert!(row.expires_at > now() + OPERATOR_SESSION_TTL_MS - 5_000);

    let mut set = HeaderMap::new();
    set_operator_cookie(&mut set, state, &token);
    let cookie = cookie_value(&set);
    assert_eq!(cookie, token);
    let raw = set.get("set-cookie").unwrap().to_str().unwrap();
    assert!(raw.contains("Path=/v1"));
    assert!(raw.contains("HttpOnly"));
    assert!(raw.contains("SameSite=Strict"));
    assert!(!raw.contains("Secure"));

    let jar = headers(&[("cookie", &format!("__orbit_operator={token}"))]);
    let found = find_operator_session(state, &jar).await.unwrap().unwrap();
    assert_eq!(found.id, row.id);
    assert!(find_operator_session(state, &headers(&[]))
        .await
        .unwrap()
        .is_none());
    assert!(
        find_operator_session(state, &headers(&[("cookie", "__orbit_operator=wrong")]))
            .await
            .unwrap()
            .is_none()
    );

    assert!(revoke_operator_session(state, &jar).await.unwrap());
    assert!(find_operator_session(state, &jar).await.unwrap().is_none());
    assert!(!revoke_operator_session(state, &jar).await.unwrap());
}

#[tokio::test]
async fn operator_cookie_is_secure_over_https() {
    let app = test_app_state_with(EnvOverrides {
        base_url: Some("https://auth.example.com".into()),
        ..Default::default()
    })
    .await;
    let state = app.state();
    let (_, token) = issue_operator_session(state, None, None).await.unwrap();
    let mut set = HeaderMap::new();
    set_operator_cookie(&mut set, state, &token);
    assert!(set
        .get("set-cookie")
        .unwrap()
        .to_str()
        .unwrap()
        .contains("Secure"));
}

#[tokio::test]
async fn expired_or_revoked_sessions_are_rejected_and_swept() {
    let app = test_app_state().await;
    let state = app.state();
    let (row, token) = issue_operator_session(state, None, None).await.unwrap();
    let jar = headers(&[("cookie", &format!("__orbit_operator={token}"))]);
    assert!(find_operator_session(state, &jar).await.unwrap().is_some());
    sqlx::query("UPDATE operator_sessions SET expires_at = $1 WHERE id = $2")
        .bind(now() - 1)
        .bind(&row.id)
        .execute(&state.pool)
        .await
        .unwrap();
    assert!(find_operator_session(state, &jar).await.unwrap().is_none());
    sweep_operator_sessions(state).await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM operator_sessions")
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn rotated_secret_invalidates_sessions() {
    let app = test_app_state().await;
    let state = app.state();
    let (row, token) = issue_operator_session(state, None, None).await.unwrap();
    let jar = headers(&[("cookie", &format!("__orbit_operator={token}"))]);
    sqlx::query("UPDATE operator_sessions SET key_fingerprint = 'other' WHERE id = $1")
        .bind(&row.id)
        .execute(&state.pool)
        .await
        .unwrap();
    assert!(find_operator_session(state, &jar).await.unwrap().is_none());
    revoke_all_operator_sessions(state).await.unwrap();
    let revoked: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM operator_sessions WHERE revoked_at IS NOT NULL")
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert_eq!(revoked, 0);
}

#[tokio::test]
async fn operator_cookie_origin_rules() {
    let app = test_app_state().await;
    let state = app.state();
    assert!(operator_cookie_origin_allowed(
        state,
        &headers(&[
            ("origin", "http://localhost:4000"),
            ("sec-fetch-site", "same-origin")
        ])
    ));
    assert!(operator_cookie_origin_allowed(
        state,
        &headers(&[("origin", "http://localhost:4000")])
    ));
    assert!(!operator_cookie_origin_allowed(
        state,
        &headers(&[("origin", "https://evil.example")])
    ));
    assert!(!operator_cookie_origin_allowed(
        state,
        &headers(&[("origin", "null")])
    ));
    assert!(!operator_cookie_origin_allowed(
        state,
        &headers(&[
            ("origin", "http://localhost:5173"),
            ("sec-fetch-site", "same-origin")
        ])
    ));
    assert!(!operator_cookie_origin_allowed(
        state,
        &headers(&[("sec-fetch-site", "cross-site")])
    ));
    assert!(operator_cookie_origin_allowed(
        state,
        &headers(&[("referer", "http://localhost:4000/v1/users")])
    ));
    assert!(!operator_cookie_origin_allowed(
        state,
        &headers(&[("referer", "http://evil.example/v1/users")])
    ));
    assert!(operator_cookie_origin_allowed(state, &headers(&[])));
}

#[tokio::test]
async fn install_registers_the_operator_hook_and_clears_cookie() {
    let app = test_app_state().await;
    let state = app.state();
    assert!(state.operator_session_checker().is_some());
    let mut cleared = HeaderMap::new();
    clear_operator_cookie(&mut cleared);
    let raw = cleared.get("set-cookie").unwrap().to_str().unwrap();
    assert!(raw.starts_with("__orbit_operator=;"));
    assert!(raw.contains("Max-Age=0"));
    assert!(raw.contains("Path=/v1"));
}

#[tokio::test]
async fn trusted_device_labels_use_a_fixed_vocabulary() {
    for (agent, expected) in [
        (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
            "Safari on macOS",
        ),
        (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
            "Chrome on Windows",
        ),
        (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0",
            "Edge on Windows",
        ),
        (
            "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
            "Firefox on Linux",
        ),
        (
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
            "Safari on iOS",
        ),
        ("", "Trusted browser"),
        ("curl/8.5.0", "Trusted browser"),
    ] {
        assert_eq!(trusted_device_label(Some(agent)), expected, "{agent}");
    }
    assert_eq!(
        trusted_device_label(Some("<script>alert(1)</script>\r\nSet-Cookie: x=1 Firefox")),
        "Firefox"
    );
    assert_eq!(trusted_device_label(None), "Trusted browser");
}

#[tokio::test]
async fn trusted_device_issue_redeem_and_replay() {
    let app = test_app_state().await;
    let state = app.state();
    enable_trusted_devices(state, 30).await.unwrap();
    let user = create_test_user(state, "device@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let (row, token) = issue_trusted_device(
        state,
        &user.user.id,
        Some("Mozilla/5.0 (Windows NT 10.0) Chrome/126.0"),
        Some("127.0.0.1"),
    )
    .await
    .unwrap();
    assert_eq!(row.label.as_deref(), Some("Chrome on Windows"));
    assert_eq!(row.token_hash, orbitid_core::crypto::sha256(&token));
    assert!(row.expires_at > now() + 29 * 24 * 3600 * 1000);
    assert!(trusted_device_valid(&row, now()));

    let mut set = HeaderMap::new();
    set_trusted_device_cookie(&mut set, state, &token, row.expires_at);
    let raw = set.get("set-cookie").unwrap().to_str().unwrap();
    assert!(raw.starts_with(&format!("__orbit_trusted={token}")));
    assert!(raw.contains("HttpOnly"));
    assert!(raw.contains("SameSite=Lax"));
    let jar = headers(&[("cookie", &format!("__orbit_trusted={token}"))]);
    assert_eq!(
        read_trusted_device_token(&jar).as_deref(),
        Some(token.as_str())
    );

    let (rotated_row, rotated) = redeem_trusted_device(state, &token, &user.user.id)
        .await
        .unwrap()
        .expect("redeemed");
    assert_ne!(rotated, token);
    assert_eq!(rotated_row.expires_at, row.expires_at);
    assert_eq!(
        rotated_row.token_hash,
        orbitid_core::crypto::sha256(&rotated)
    );
    // The old value is dead.
    assert!(redeem_trusted_device(state, &token, &user.user.id)
        .await
        .unwrap()
        .is_none());
    // A foreign user cannot redeem it either.
    let stranger = create_test_user(state, "device2@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    assert!(redeem_trusted_device(state, &rotated, &stranger.user.id)
        .await
        .unwrap()
        .is_none());

    let list = list_trusted_devices(state, &user.user.id).await.unwrap();
    assert_eq!(list.len(), 1);
    let revoked = revoke_trusted_device(state, &user.user.id, &rotated_row.id)
        .await
        .unwrap();
    assert!(revoked.is_some());
    assert!(list_trusted_devices(state, &user.user.id)
        .await
        .unwrap()
        .is_empty());
    assert!(
        revoke_trusted_device(state, &stranger.user.id, &rotated_row.id)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn expired_devices_are_not_redeemable_and_can_all_be_revoked() {
    let app = test_app_state().await;
    let state = app.state();
    enable_trusted_devices(state, 30).await.unwrap();
    let user = create_test_user(state, "device-expire@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let (row, token) = issue_trusted_device(state, &user.user.id, None, None)
        .await
        .unwrap();
    sqlx::query("UPDATE trusted_devices SET expires_at = $1 WHERE id = $2")
        .bind(now() - 1)
        .bind(&row.id)
        .execute(&state.pool)
        .await
        .unwrap();
    assert!(redeem_trusted_device(state, &token, &user.user.id)
        .await
        .unwrap()
        .is_none());
    let second = issue_trusted_device(state, &user.user.id, None, None)
        .await
        .unwrap();
    let revoked = revoke_all_trusted_devices(state, &user.user.id)
        .await
        .unwrap();
    // The expired row is already past its expiry and is not "live", but it is
    // still unrevoked; revokeAll touches every unrevoked row.
    assert_eq!(revoked, 2);
    assert_eq!(second.0.revoked_at, None);
    let mut cleared = HeaderMap::new();
    clear_trusted_device_cookie(&mut cleared, state);
    assert!(cleared
        .get("set-cookie")
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("__orbit_trusted=;"));
}

#[allow(dead_code)]
fn _state_is_send_sync(state: &AppState) {
    fn assert_send_sync<T: Send + Sync>(_: &T) {}
    assert_send_sync(state);
}
