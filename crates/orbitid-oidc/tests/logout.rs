//! Ported from `test/core/oidc-interop-rp.test.ts` (oauth2-proxy walk) and
//! `test/core/oidc-session-lifecycle.test.ts`: RP-initiated logout.

mod common;

use axum::body::Body;
use axum::http::{Method, StatusCode};
use serde_json::json;

use common::{code_flow, harness, insert_user, location, send};

const POST_LOGOUT: &str = "http://localhost:3000/oauth2/sign_out";

#[tokio::test]
async fn end_session_verifies_the_hint_and_ends_the_session() {
    let h = harness().await;
    let browser = insert_user(&h, "user@example.com").await;
    let app = h
        .create_app(json!({ "post_logout_redirect_uris": [POST_LOGOUT] }))
        .await;
    let flow = code_flow(&h, &browser, &app, "openid email offline_access").await;
    let id_token = flow.tokens["id_token"].as_str().unwrap();

    let response = h
        .client
        .get(
            &format!("/oauth/end_session?{}", {
                url::form_urlencoded::Serializer::new(String::new())
                    .extend_pairs([
                        ("id_token_hint", id_token),
                        ("post_logout_redirect_uri", POST_LOGOUT),
                        ("state", "bye"),
                    ])
                    .finish()
            }),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::FOUND);
    let target = location(&response);
    assert!(target.starts_with(POST_LOGOUT));
    assert!(target.contains("state=bye"));
    assert_eq!(response.headers.get("cache-control").unwrap(), "no-store");

    let status: String = sqlx::query_scalar("SELECT status FROM sessions WHERE id = $1")
        .bind(&browser.session_id)
        .fetch_one(&h.state().pool)
        .await
        .unwrap();
    assert_eq!(status, "ended");

    let info = h
        .client
        .get(
            "/oauth/userinfo",
            &[(
                "authorization",
                &format!("Bearer {}", flow.tokens["access_token"].as_str().unwrap()),
            )],
        )
        .await;
    assert_eq!(info.status, StatusCode::UNAUTHORIZED);
    let refresh = h
        .form(
            "/oauth/token",
            &[
                ("grant_type", "refresh_token"),
                (
                    "refresh_token",
                    flow.tokens["refresh_token"].as_str().unwrap(),
                ),
                ("client_id", app["client_id"].as_str().unwrap()),
                ("client_secret", app["client_secret"].as_str().unwrap()),
            ],
        )
        .await;
    assert_eq!(refresh.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn end_session_by_client_id_and_form_post() {
    let h = harness().await;
    let browser = insert_user(&h, "user@example.com").await;
    let app = h
        .create_app(json!({ "post_logout_redirect_uris": [POST_LOGOUT] }))
        .await;
    let client_id = app["client_id"].as_str().unwrap();

    let by_client = h
        .client
        .get(
            &format!(
                "/oauth/end_session?client_id={client_id}&post_logout_redirect_uri={}",
                url::form_urlencoded::byte_serialize(POST_LOGOUT.as_bytes()).collect::<String>()
            ),
            &[],
        )
        .await;
    assert_eq!(by_client.status, StatusCode::FOUND);
    assert!(location(&by_client).starts_with(POST_LOGOUT));

    let flow = code_flow(&h, &browser, &app, "openid").await;
    let form = send(
        &h.router,
        Method::POST,
        "/oauth/end_session",
        Body::from(
            url::form_urlencoded::Serializer::new(String::new())
                .extend_pairs([
                    ("id_token_hint", flow.tokens["id_token"].as_str().unwrap()),
                    ("post_logout_redirect_uri", POST_LOGOUT),
                    ("state", "form"),
                ])
                .finish(),
        ),
        &[("content-type", "application/x-www-form-urlencoded")],
    )
    .await;
    assert_eq!(form.status, StatusCode::FOUND);
    assert!(location(&form).contains("state=form"));

    // No parameters: home page.
    let home = h.client.get("/oauth/end_session", &[]).await;
    assert_eq!(home.status, StatusCode::FOUND);
    assert_eq!(location(&home), "http://localhost:3000");
}

#[tokio::test]
async fn end_session_refuses_unsafe_or_inconsistent_parameters() {
    let h = harness().await;
    let browser = insert_user(&h, "user@example.com").await;
    let app = h
        .create_app(json!({ "post_logout_redirect_uris": [POST_LOGOUT] }))
        .await;
    let flow = code_flow(&h, &browser, &app, "openid").await;
    let id_token = flow.tokens["id_token"].as_str().unwrap();
    let client_id = app["client_id"].as_str().unwrap();

    let unregistered = h
        .client
        .get(
            &format!("/oauth/end_session?{}", {
                url::form_urlencoded::Serializer::new(String::new())
                    .extend_pairs([
                        ("client_id", client_id),
                        ("post_logout_redirect_uri", "https://evil.example/bye"),
                    ])
                    .finish()
            }),
            &[],
        )
        .await;
    assert_eq!(unregistered.status, StatusCode::BAD_REQUEST);
    assert_eq!(unregistered.value()["error"], "invalid_request");

    let no_client = h
        .client
        .get(
            &format!("/oauth/end_session?{}", {
                url::form_urlencoded::Serializer::new(String::new())
                    .extend_pairs([("post_logout_redirect_uri", POST_LOGOUT)])
                    .finish()
            }),
            &[],
        )
        .await;
    assert_eq!(no_client.status, StatusCode::BAD_REQUEST);

    let bad_hint = h
        .client
        .get(
            &format!("/oauth/end_session?{}", {
                url::form_urlencoded::Serializer::new(String::new())
                    .extend_pairs([
                        ("id_token_hint", "not-a-token"),
                        ("post_logout_redirect_uri", POST_LOGOUT),
                    ])
                    .finish()
            }),
            &[],
        )
        .await;
    assert_eq!(bad_hint.status, StatusCode::BAD_REQUEST);

    let other = h
        .create_app(json!({ "name": "Other", "post_logout_redirect_uris": [POST_LOGOUT] }))
        .await;
    let mismatched = h
        .client
        .get(
            &format!("/oauth/end_session?{}", {
                url::form_urlencoded::Serializer::new(String::new())
                    .extend_pairs([
                        ("id_token_hint", id_token),
                        ("client_id", other["client_id"].as_str().unwrap()),
                        ("post_logout_redirect_uri", POST_LOGOUT),
                    ])
                    .finish()
            }),
            &[],
        )
        .await;
    assert_eq!(mismatched.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        mismatched.value()["error_description"],
        "client_id does not match the id_token_hint audience"
    );

    let unknown = h
        .client
        .get(
            &format!("/oauth/end_session?{}", {
                url::form_urlencoded::Serializer::new(String::new())
                    .extend_pairs([
                        ("client_id", "oa_missing"),
                        ("post_logout_redirect_uri", POST_LOGOUT),
                    ])
                    .finish()
            }),
            &[],
        )
        .await;
    assert_eq!(unknown.status, StatusCode::BAD_REQUEST);
    assert_eq!(unknown.value()["error"], "invalid_request");
}

#[tokio::test]
async fn a_hint_only_ends_the_session_it_describes() {
    let h = harness().await;
    let first = insert_user(&h, "user@example.com").await;
    let second = insert_user(&h, "other@example.com").await;
    let app = h
        .create_app(json!({ "post_logout_redirect_uris": [POST_LOGOUT] }))
        .await;
    let flow = code_flow(&h, &second, &app, "openid").await;
    let id_token = flow.tokens["id_token"].as_str().unwrap();
    let response = h
        .client
        .get(&format!("/oauth/end_session?id_token_hint={id_token}"), &[])
        .await;
    assert_eq!(response.status, StatusCode::FOUND);
    assert_eq!(location(&response), "http://localhost:3000");
    let second_status: String = sqlx::query_scalar("SELECT status FROM sessions WHERE id = $1")
        .bind(&second.session_id)
        .fetch_one(&h.state().pool)
        .await
        .unwrap();
    assert_eq!(second_status, "ended");
    let first_status: String = sqlx::query_scalar("SELECT status FROM sessions WHERE id = $1")
        .bind(&first.session_id)
        .fetch_one(&h.state().pool)
        .await
        .unwrap();
    assert_eq!(first_status, "active");
}
