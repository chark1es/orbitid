use axum::http::{HeaderMap, HeaderValue};
use orbitid_core::error::error_codes;
use orbitid_core::http::now;
use orbitid_identity::client_auth::{
    active_client_session, clear_client_cookie, client_azp, find_client, get_or_create_client,
    read_client_token, renew_client_cookie_if_due, require_active_user, require_client,
    serialize_client,
};
use orbitid_identity::testing::{create_test_client_session, create_test_user, test_app_state};

fn make_headers(pairs: &[(&str, &str)]) -> HeaderMap {
    let mut headers = HeaderMap::new();
    for (name, value) in pairs {
        headers.insert(
            name.parse::<axum::http::header::HeaderName>().unwrap(),
            HeaderValue::from_str(value).unwrap(),
        );
    }
    headers
}

#[tokio::test]
async fn bootstrap_creates_a_client_and_durable_cookie() {
    let app = test_app_state().await;
    let state = app.state();
    let headers = make_headers(&[("user-agent", "Mozilla/5.0 Chrome/126.0")]);
    let (client, cookie) = get_or_create_client(state, &headers, "GET", "/v1/client")
        .await
        .unwrap();
    let cookie = cookie.expect("first bootstrap sets the cookie");
    assert!(cookie.starts_with("__client="));
    assert!(cookie.contains("Max-Age="));
    assert!(cookie.contains("HttpOnly"));
    assert!(cookie.contains("SameSite=Lax"));
    assert!(cookie.contains("Path=/"));
    let token = cookie
        .strip_prefix("__client=")
        .and_then(|rest| rest.split(';').next())
        .unwrap()
        .to_string();
    let token_headers = make_headers(&[("cookie", &format!("__client={token}"))]);
    let found = find_client(state, &token_headers).await.unwrap().unwrap();
    assert_eq!(found.id, client.id);
}

#[tokio::test]
async fn unknown_presented_token_is_only_replaced_on_bootstrap() {
    let app = test_app_state().await;
    let state = app.state();
    let headers = make_headers(&[("cookie", "__client=rotated-away-token")]);
    let error = get_or_create_client(state, &headers, "POST", "/v1/client/sign_ins")
        .await
        .unwrap_err();
    assert_eq!(error.code, error_codes::CLIENT_STATE_INVALID);
    assert_eq!(error.status.as_u16(), 401);

    // The SDK's own bootstrap may recover.
    let (_, cookie) = get_or_create_client(state, &headers, "GET", "/v1/client")
        .await
        .unwrap();
    assert!(cookie.is_some());
}

#[tokio::test]
async fn client_cookie_renews_the_same_token_after_a_day() {
    let app = test_app_state().await;
    let state = app.state();
    let user = create_test_user(state, "renew@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let auth = create_test_client_session(state, &user.user.id)
        .await
        .unwrap();
    let headers = make_headers(&[("cookie", &auth.cookie)]);
    let old_issued_at = auth.client.token_issued_at.unwrap();
    sqlx::query("UPDATE clients SET token_issued_at = $1 WHERE id = $2")
        .bind(old_issued_at - 2 * 86_400_000)
        .bind(&auth.client.id)
        .execute(&state.pool)
        .await
        .unwrap();
    let stale = find_client(state, &headers).await.unwrap().unwrap();
    let cookie = renew_client_cookie_if_due(state, &headers, &stale)
        .await
        .unwrap()
        .expect("renewal due");
    assert!(cookie.starts_with(&format!("__client={}", auth.token)));
    let after = find_client(state, &headers).await.unwrap().unwrap();
    assert_eq!(after.token_hash, stale.token_hash);
    assert!(after.token_issued_at.unwrap() > now() - 5_000);

    // A fresh cookie is not rewritten on every request.
    assert!(renew_client_cookie_if_due(state, &headers, &after)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn bearer_token_authenticates_a_client() {
    let app = test_app_state().await;
    let state = app.state();
    let user = create_test_user(state, "bearer@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let auth = create_test_client_session(state, &user.user.id)
        .await
        .unwrap();
    let headers = make_headers(&[("authorization", &format!("Bearer {}", auth.token))]);
    assert_eq!(
        read_client_token(&headers).as_deref(),
        Some(auth.token.as_str())
    );
    let client = require_client(state, &headers).await.unwrap();
    assert_eq!(client.id, auth.client.id);
    // Secret keys are never mistaken for client tokens.
    let key_headers = make_headers(&[("authorization", "Bearer sk_test_testsecret")]);
    assert!(read_client_token(&key_headers).is_none());
}

#[tokio::test]
async fn serialize_client_mints_tokens_only_for_the_owner() {
    let app = test_app_state().await;
    let state = app.state();
    let user = create_test_user(state, "serialize@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let auth = create_test_client_session(state, &user.user.id)
        .await
        .unwrap();

    let owned = serialize_client(state, &auth.client, Some("http://localhost:3000"), true)
        .await
        .unwrap();
    assert_eq!(owned.object, "client");
    assert_eq!(owned.sessions.len(), 1);
    assert!(owned.sessions[0].last_active_token.is_some());
    assert_eq!(owned.sessions[0].user.as_ref().unwrap().id, user.user.id);
    assert!(owned.cookie_expires_at.unwrap() > now());

    let backend = serialize_client(state, &auth.client, None, false)
        .await
        .unwrap();
    assert!(backend.sessions[0].last_active_token.is_none());
    assert!(backend.sign_in.is_none());
    assert!(backend.sign_up.is_none());
}

#[tokio::test]
async fn active_session_falls_back_to_the_newest_live_one() {
    let app = test_app_state().await;
    let state = app.state();
    let user = create_test_user(state, "fallback@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let auth = create_test_client_session(state, &user.user.id)
        .await
        .unwrap();
    sqlx::query("UPDATE clients SET last_active_session_id = NULL WHERE id = $1")
        .bind(&auth.client.id)
        .execute(&state.pool)
        .await
        .unwrap();
    let client = require_client(state, &make_headers(&[("cookie", &auth.cookie)]))
        .await
        .unwrap();
    let session = active_client_session(state, &client)
        .await
        .unwrap()
        .expect("active session");
    assert_eq!(session.id, auth.session.id);
    let (_, user_row) = require_active_user(state, &client).await.unwrap();
    assert_eq!(user_row.id, user.user.id);
}

#[tokio::test]
async fn banned_users_are_refused() {
    let app = test_app_state().await;
    let state = app.state();
    let user = create_test_user(state, "banned-client@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let auth = create_test_client_session(state, &user.user.id)
        .await
        .unwrap();
    sqlx::query("UPDATE users SET banned = true WHERE id = $1")
        .bind(&user.user.id)
        .execute(&state.pool)
        .await
        .unwrap();
    let error = require_active_user(state, &auth.client).await.unwrap_err();
    assert_eq!(error.code, error_codes::USER_BANNED);
}

#[tokio::test]
async fn azp_uses_origin_then_referer() {
    assert_eq!(
        client_azp(&make_headers(&[("origin", "http://localhost:3000")])).as_deref(),
        Some("http://localhost:3000")
    );
    assert_eq!(
        client_azp(&make_headers(&[(
            "referer",
            "http://localhost:3000/app/page"
        )]))
        .as_deref(),
        Some("http://localhost:3000")
    );
    assert!(client_azp(&make_headers(&[("referer", "not a url")])).is_none());
    assert!(client_azp(&make_headers(&[])).is_none());
}

#[tokio::test]
async fn clear_cookie_expires_it() {
    let app = test_app_state().await;
    let mut headers = HeaderMap::new();
    clear_client_cookie(&mut headers, app.state());
    let line = headers.get("set-cookie").unwrap().to_str().unwrap();
    assert!(line.starts_with("__client=;"));
    assert!(line.contains("Max-Age=0"));
}

#[tokio::test]
async fn cookie_token_takes_precedence_and_is_percent_decoded() {
    let h = make_headers(&[
        ("cookie", "__client=abc%3Ddef"),
        ("authorization", "Bearer other"),
    ]);
    assert_eq!(read_client_token(&h).as_deref(), Some("abc=def"));
}
