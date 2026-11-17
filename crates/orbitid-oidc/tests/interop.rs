//! Ported from `test/core/oidc-interop-*`, `security/silent-auth` provider parts
//! and `oidc-provider-tokens` (JWT access tokens).

mod common;

use axum::body::Body;
use axum::http::{Method, StatusCode};
use serde_json::json;

use common::{
    authorize, basic, challenge_for, code_flow, decode_claims, harness, insert_user, location,
    pkce_verifier, send, settings, REDIRECT_URI,
};

#[tokio::test]
async fn form_post_response_mode() {
    let h = harness().await;
    let browser = insert_user(&h, "user@example.com").await;
    let app = h.create_app(json!({})).await;
    let response = send(
        &h.router,
        Method::GET,
        &format!("/oauth/authorize?{}", {
            url::form_urlencoded::Serializer::new(String::new())
                .extend_pairs([
                    ("client_id", app["client_id"].as_str().unwrap()),
                    ("redirect_uri", REDIRECT_URI),
                    ("response_type", "code"),
                    ("scope", "openid"),
                    ("state", "fp"),
                    ("response_mode", "form_post"),
                ])
                .finish()
        }),
        Body::empty(),
        &[("cookie", &browser.cookie)],
    )
    .await;
    assert_eq!(response.status, StatusCode::OK);
    let csp = response
        .headers
        .get("content-security-policy")
        .unwrap()
        .to_str()
        .unwrap();
    assert!(csp.contains("form-action http://localhost:3000"));
    let html = response.text();
    assert!(html.contains(&format!("action=\"{REDIRECT_URI}\"")));
    assert!(html.contains("name=\"code\""));
    assert!(html.contains("name=\"state\" value=\"fp\""));
    assert!(!html.contains("<script>document.forms[0].submit()</script>"));
}

#[tokio::test]
async fn prompt_login_and_max_age_do_not_loop() {
    let h = harness().await;
    let browser = insert_user(&h, "user@example.com").await;
    let app = h.create_app(json!({})).await;
    let client_id = app["client_id"].as_str().unwrap();

    let forced = authorize(
        &h,
        &browser,
        &[
            ("client_id", client_id),
            ("redirect_uri", REDIRECT_URI),
            ("response_type", "code"),
            ("scope", "openid"),
            ("prompt", "login"),
            ("max_age", "0"),
        ],
    )
    .await;
    // `authorize` follows a redirect only; a sign-in redirect has no code.
    assert!(!forced.contains_key("code"));

    let response = send(
        &h.router,
        Method::GET,
        &format!("/oauth/authorize?{}", {
            url::form_urlencoded::Serializer::new(String::new())
                .extend_pairs([
                    ("client_id", client_id),
                    ("redirect_uri", REDIRECT_URI),
                    ("response_type", "code"),
                    ("scope", "openid"),
                    ("prompt", "login"),
                    ("max_age", "0"),
                ])
                .finish()
        }),
        Body::empty(),
        &[("cookie", &browser.cookie)],
    )
    .await;
    assert_eq!(response.status, StatusCode::FOUND);
    let target = url::Url::parse(&location(&response)).unwrap();
    assert_eq!(
        format!("{}{}", target.origin().ascii_serialization(), target.path()),
        "http://localhost:3000/sign-in"
    );
    let return_url = url::Url::parse(
        &target
            .query_pairs()
            .find(|(key, _)| key == "redirect_url")
            .unwrap()
            .1,
    )
    .unwrap();
    assert!(return_url.query_pairs().all(|(key, _)| key != "prompt"));
    assert!(return_url.query_pairs().all(|(key, _)| key != "max_age"));

    // A stale first factor cannot satisfy max_age.
    sqlx::query("UPDATE sessions SET first_factor_verified_at = $1 WHERE id = $2")
        .bind(orbitid_core::http::now() - 10 * 60_000)
        .bind(&browser.session_id)
        .execute(&h.state().pool)
        .await
        .unwrap();
    let silent = authorize(
        &h,
        &browser,
        &[
            ("client_id", client_id),
            ("redirect_uri", REDIRECT_URI),
            ("response_type", "code"),
            ("scope", "openid"),
            ("prompt", "none"),
            ("max_age", "60"),
        ],
    )
    .await;
    assert_eq!(silent["error"], "login_required");

    let interactive = send(
        &h.router,
        Method::GET,
        &format!("/oauth/authorize?{}", {
            url::form_urlencoded::Serializer::new(String::new())
                .extend_pairs([
                    ("client_id", client_id),
                    ("redirect_uri", REDIRECT_URI),
                    ("response_type", "code"),
                    ("scope", "openid"),
                    ("max_age", "60"),
                ])
                .finish()
        }),
        Body::empty(),
        &[("cookie", &browser.cookie)],
    )
    .await;
    assert_eq!(interactive.status, StatusCode::FOUND);
    assert_eq!(
        url::Url::parse(&location(&interactive)).unwrap().path(),
        "/sign-in"
    );
}

#[tokio::test]
async fn login_hint_for_another_account_is_not_silent_sso() {
    let h = harness().await;
    let browser = insert_user(&h, "user@example.com").await;
    insert_user(&h, "other-hint@example.com").await;
    let app = h.create_app(json!({})).await;
    let client_id = app["client_id"].as_str().unwrap();
    let silent = authorize(
        &h,
        &browser,
        &[
            ("client_id", client_id),
            ("redirect_uri", REDIRECT_URI),
            ("response_type", "code"),
            ("scope", "openid"),
            ("prompt", "none"),
            ("login_hint", "other-hint@example.com"),
        ],
    )
    .await;
    assert_eq!(silent["error"], "login_required");

    // Same account is fine.
    let same = authorize(
        &h,
        &browser,
        &[
            ("client_id", client_id),
            ("redirect_uri", REDIRECT_URI),
            ("response_type", "code"),
            ("scope", "openid"),
            ("prompt", "none"),
            ("login_hint", "user@example.com"),
        ],
    )
    .await;
    assert!(same["code"].starts_with("oac_"));
}

#[tokio::test]
async fn loopback_ports_are_tolerated_but_host_and_path_are_not() {
    let h = harness().await;
    let browser = insert_user(&h, "user@example.com").await;
    let app = h
        .create_app(json!({
            "name": "Native",
            "redirect_uris": ["http://127.0.0.1/callback"],
            "pkce_required": true,
        }))
        .await;
    let verifier = pkce_verifier();
    let ok = authorize(
        &h,
        &browser,
        &[
            ("client_id", app["client_id"].as_str().unwrap()),
            ("redirect_uri", "http://127.0.0.1:53121/callback"),
            ("response_type", "code"),
            ("scope", "openid"),
            ("code_challenge", &challenge_for(&verifier)),
        ],
    )
    .await;
    assert!(ok["code"].starts_with("oac_"));

    for redirect in [
        "http://localhost:53121/callback",
        "http://127.0.0.1:53121/other",
    ] {
        let rejected = h
            .client
            .get(
                &format!("/oauth/authorize?{}", {
                    url::form_urlencoded::Serializer::new(String::new())
                        .extend_pairs([
                            ("client_id", app["client_id"].as_str().unwrap()),
                            ("redirect_uri", redirect),
                            ("response_type", "code"),
                            ("scope", "openid"),
                        ])
                        .finish()
                }),
                &[("cookie", &browser.cookie)],
            )
            .await;
        assert_eq!(rejected.status, StatusCode::BAD_REQUEST, "{redirect}");
    }
}

#[tokio::test]
async fn rfc6749_form_encoded_and_raw_basic_credentials_both_work() {
    let h = harness().await;
    let browser = insert_user(&h, "user@example.com").await;
    let app = h.create_app(json!({})).await;
    let client_id = app["client_id"].as_str().unwrap();
    let secret = "s3cret with space:and-colon";
    sqlx::query("UPDATE oauth_applications SET client_secret_hash = $2 WHERE id = $1")
        .bind(app["id"].as_str().unwrap())
        .bind(orbitid_core::crypto::sha256(secret))
        .execute(&h.state().pool)
        .await
        .unwrap();

    // Raw Basic (the common mistake) and RFC 6749 form-encoded Basic.
    for encoded in [false, true] {
        let query = authorize(
            &h,
            &browser,
            &[
                ("client_id", client_id),
                ("redirect_uri", REDIRECT_URI),
                ("response_type", "code"),
                ("scope", "openid"),
            ],
        )
        .await;
        let key = if encoded {
            "s3cret%20with%20space%3Aand-colon"
        } else {
            secret
        };
        let response = h
            .form_with_auth(
                "/oauth/token",
                &[
                    ("grant_type", "authorization_code"),
                    ("code", query["code"].as_str()),
                    ("redirect_uri", REDIRECT_URI),
                ],
                &basic(client_id, key),
            )
            .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    }
}

#[tokio::test]
async fn jwt_access_tokens_are_signed_recorded_and_revocable() {
    let h = harness().await;
    settings(
        &h,
        json!({ "oidcProvider": { "accessTokenFormat": "jwt" } }),
    )
    .await;
    let browser = insert_user(&h, "user@example.com").await;
    let app = h.create_app(json!({})).await;
    let flow = code_flow(&h, &browser, &app, "openid email offline_access").await;
    let access = flow.tokens["access_token"].as_str().unwrap();
    assert!(!access.starts_with("oat_"));

    let claims = decode_claims(access);
    assert_eq!(claims["iss"], common::BASE_URL);
    assert_eq!(claims["sub"], browser.user.id);
    assert_eq!(claims["aud"], app["client_id"]);
    assert_eq!(claims["azp"], app["client_id"]);
    assert_eq!(claims["scope"], "openid email offline_access");
    assert_eq!(claims["sid"], browser.session_id);
    assert!(claims["iat"].is_number());
    assert!(claims["exp"].is_number());
    assert!(claims["jti"].is_string());

    let info = h
        .client
        .get(
            "/oauth/userinfo",
            &[("authorization", &format!("Bearer {access}"))],
        )
        .await;
    assert_eq!(info.status, StatusCode::OK);
    assert_eq!(info.value()["email"], "user@example.com");

    h.form_with_auth(
        "/oauth/revoke",
        &[("token", access)],
        &basic(
            app["client_id"].as_str().unwrap(),
            app["client_secret"].as_str().unwrap(),
        ),
    )
    .await;
    let after = h
        .client
        .get(
            "/oauth/userinfo",
            &[("authorization", &format!("Bearer {access}"))],
        )
        .await;
    assert_eq!(after.status, StatusCode::UNAUTHORIZED);
    let introspected = h
        .form_with_auth(
            "/oauth/introspect",
            &[("token", access)],
            &basic(
                app["client_id"].as_str().unwrap(),
                app["client_secret"].as_str().unwrap(),
            ),
        )
        .await;
    assert_eq!(introspected.value(), json!({ "active": false }));

    // Discovery advertises the JWT format.
    let doc = h
        .client
        .get("/.well-known/openid-configuration", &[])
        .await
        .value();
    assert_eq!(doc["access_token_format"], "jwt");

    // A grant row whose token is a forged/garbage JWS is rejected.
    let now = orbitid_core::http::now();
    let forged = "aaa.bbb.ccc";
    sqlx::query(
        "INSERT INTO oauth_grants (id, kind, application_id, user_id, token_hash, scopes, \
         session_id, revoked, expires_at, created_at) VALUES ($1,'access',$2,$3,$4,'openid',$5,false,$6,$7)",
    )
    .bind(orbitid_core::ids::new_id(orbitid_core::ids::id_prefix::OAUTH_GRANT))
    .bind(app["id"].as_str().unwrap())
    .bind(&browser.user.id)
    .bind(orbitid_core::crypto::sha256(forged))
    .bind(&browser.session_id)
    .bind(now + 600_000)
    .bind(now)
    .execute(&h.state().pool)
    .await
    .unwrap();
    let rejected = h
        .client
        .get(
            "/oauth/userinfo",
            &[("authorization", &format!("Bearer {forged}"))],
        )
        .await;
    assert_eq!(rejected.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn jwt_access_token_refresh_preserves_the_session_binding() {
    let h = harness().await;
    settings(
        &h,
        json!({ "oidcProvider": { "accessTokenFormat": "jwt" } }),
    )
    .await;
    let browser = insert_user(&h, "user@example.com").await;
    let app = h.create_app(json!({})).await;
    let flow = code_flow(&h, &browser, &app, "openid email offline_access").await;
    let refreshed = h
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
    assert_eq!(refreshed.status, StatusCode::OK);
    let claims = decode_claims(refreshed.value()["access_token"].as_str().unwrap());
    assert_eq!(claims["sid"], browser.session_id);
}

#[tokio::test]
async fn concurrent_refreshes_do_not_destroy_the_grant() {
    let h = harness().await;
    let browser = insert_user(&h, "user@example.com").await;
    let app = h.create_app(json!({})).await;
    let flow = code_flow(&h, &browser, &app, "openid email offline_access").await;
    let refresh = flow.tokens["refresh_token"].as_str().unwrap().to_string();
    let client_id = app["client_id"].as_str().unwrap().to_string();
    let secret = app["client_secret"].as_str().unwrap().to_string();

    let request = |token: String, client_id: String, secret: String| {
        let path = "/oauth/token".to_string();
        let router = h.router.clone();
        async move {
            send(
                &router,
                Method::POST,
                &path,
                Body::from(
                    url::form_urlencoded::Serializer::new(String::new())
                        .extend_pairs([
                            ("grant_type", "refresh_token"),
                            ("refresh_token", token.as_str()),
                            ("client_id", client_id.as_str()),
                            ("client_secret", secret.as_str()),
                        ])
                        .finish(),
                ),
                &[("content-type", "application/x-www-form-urlencoded")],
            )
            .await
        }
    };
    let (a, b) = tokio::join!(
        request(refresh.clone(), client_id.clone(), secret.clone()),
        request(refresh, client_id, secret)
    );
    let winner = if a.status == StatusCode::OK {
        a.value()
    } else {
        assert_eq!(b.status, StatusCode::OK, "{}", b.text());
        b.value()
    };
    let survivor = h
        .form(
            "/oauth/token",
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", winner["refresh_token"].as_str().unwrap()),
                ("client_id", app["client_id"].as_str().unwrap()),
                ("client_secret", app["client_secret"].as_str().unwrap()),
            ],
        )
        .await;
    assert_eq!(survivor.status, StatusCode::OK);
}
