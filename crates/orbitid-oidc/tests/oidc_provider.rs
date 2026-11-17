//! Ported from `test/core/oidc-provider-*.test.ts`, `oidc-scope-allowlist`,
//! `oidc-session-lifecycle` and `machine/oidc.test.ts`: discovery, authorize,
//! token lifecycle, consent, applications CRUD and hardening.

mod common;

use axum::body::Body;
use axum::http::{Method, StatusCode};
use serde_json::json;

use common::{
    authorize, basic, challenge_for, code_flow, decode_claims, harness, insert_user, location,
    pkce_verifier, query_of, send, settings, REDIRECT_URI,
};

#[tokio::test]
async fn discovery_and_jwks_are_public_and_correct() {
    let h = harness().await;
    let response = h.client.get("/.well-known/openid-configuration", &[]).await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(
        response.headers.get("cache-control").unwrap(),
        "public, max-age=300"
    );
    let doc = response.value();
    assert_eq!(doc["issuer"], common::BASE_URL);
    assert_eq!(
        doc["authorization_endpoint"],
        format!("{}/oauth/authorize", common::BASE_URL)
    );
    assert_eq!(
        doc["token_endpoint"],
        format!("{}/oauth/token", common::BASE_URL)
    );
    assert_eq!(
        doc["userinfo_endpoint"],
        format!("{}/oauth/userinfo", common::BASE_URL)
    );
    assert_eq!(doc["jwks_uri"], format!("{}/oauth/jwks", common::BASE_URL));
    assert!(doc["code_challenge_methods_supported"]
        .as_array()
        .unwrap()
        .contains(&json!("S256")));
    assert!(doc["id_token_signing_alg_values_supported"]
        .as_array()
        .unwrap()
        .contains(&json!("RS256")));
    assert!(doc["scopes_supported"]
        .as_array()
        .unwrap()
        .contains(&json!("organizations")));
    assert!(doc["claims_supported"]
        .as_array()
        .unwrap()
        .contains(&json!("organizations")));
    assert!(doc.get("device_authorization_endpoint").is_none());
    assert_eq!(
        doc["introspection_endpoint"],
        format!("{}/oauth/introspect", common::BASE_URL)
    );
    assert_eq!(
        doc["revocation_endpoint"],
        format!("{}/oauth/revoke", common::BASE_URL)
    );
    assert_eq!(
        doc["introspection_endpoint_auth_methods_supported"],
        json!(["client_secret_basic", "client_secret_post"])
    );
    assert_eq!(
        doc["revocation_endpoint_auth_methods_supported"],
        json!(["client_secret_basic", "client_secret_post", "none"])
    );

    let jwks = h.client.get("/oauth/jwks", &[]).await;
    assert_eq!(jwks.status, StatusCode::OK);
    assert_eq!(
        jwks.headers.get("cache-control").unwrap(),
        "public, max-age=300"
    );
    assert_eq!(jwks.value()["keys"][0]["kty"], "RSA");
    for path in ["/.well-known/jwks.json", "/v1/jwks"] {
        let response = h.client.get(path, &[]).await;
        assert_eq!(response.status, StatusCode::OK, "{path}");
        assert_eq!(response.value()["keys"][0]["kty"], "RSA");
    }

    // RFC 8414 metadata and path-bearing discovery.
    for path in [
        "/.well-known/oauth-authorization-server",
        "/orbitid/.well-known/openid-configuration",
        "/orbitid/.well-known/oauth-authorization-server",
        "/.well-known/oauth-authorization-server/orbitid",
    ] {
        let response = h.client.get(path, &[]).await;
        assert_eq!(response.status, StatusCode::OK, "{path}");
        assert_eq!(response.value()["issuer"], common::BASE_URL, "{path}");
    }
}

#[tokio::test]
async fn authorize_requires_a_session_and_returns_to_sign_in() {
    let h = harness().await;
    let app = h.create_app(json!({})).await;
    let client_id = app["client_id"].as_str().unwrap();
    let verifier = pkce_verifier();
    let challenge = challenge_for(&verifier);
    let query = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs([
            ("client_id", client_id),
            ("redirect_uri", REDIRECT_URI),
            ("response_type", "code"),
            ("scope", "openid"),
            ("code_challenge", &challenge),
        ])
        .finish();
    let response = h
        .client
        .get(&format!("/oauth/authorize?{query}"), &[])
        .await;
    assert_eq!(response.status, StatusCode::FOUND);
    let target = url::Url::parse(&location(&response)).expect("url");
    assert_eq!(
        format!("{}{}", target.origin().ascii_serialization(), target.path()),
        "http://localhost:3000/sign-in"
    );
    assert!(target
        .query_pairs()
        .any(|(key, value)| key == "redirect_url" && value.contains("/oauth/authorize?")));

    // prompt=none with an existing session is silent SSO.
    let browser = insert_user(&h, "user@example.com").await;
    let query = authorize(
        &h,
        &browser,
        &[
            ("client_id", client_id),
            ("redirect_uri", REDIRECT_URI),
            ("response_type", "code"),
            ("scope", "openid"),
            ("prompt", "none"),
            ("code_challenge", &challenge),
        ],
    )
    .await;
    assert!(query["code"].starts_with("oac_"));

    let signed_out = send(
        &h.router,
        Method::GET,
        &format!("/oauth/authorize?{}", {
            url::form_urlencoded::Serializer::new(String::new())
                .extend_pairs([
                    ("client_id", client_id),
                    ("redirect_uri", REDIRECT_URI),
                    ("response_type", "code"),
                    ("scope", "openid"),
                    ("prompt", "none"),
                    ("code_challenge", &challenge),
                ])
                .finish()
        }),
        Body::empty(),
        &[],
    )
    .await;
    assert_eq!(signed_out.status, StatusCode::FOUND);
    assert_eq!(
        query_of(&location(&signed_out))
            .get("error")
            .map(String::as_str),
        Some("login_required")
    );
}

#[tokio::test]
async fn authorize_validates_client_redirect_pkce_and_scope() {
    let h = harness().await;
    let browser = insert_user(&h, "user@example.com").await;
    let app = h.create_app(json!({})).await;
    let client_id = app["client_id"].as_str().unwrap();
    let pkce = pkce_verifier();

    let issued = authorize(
        &h,
        &browser,
        &[
            ("client_id", client_id),
            ("redirect_uri", REDIRECT_URI),
            ("response_type", "code"),
            ("scope", "openid profile"),
            ("state", "abc"),
            ("code_challenge", &challenge_for(&pkce)),
            ("code_challenge_method", "S256"),
        ],
    )
    .await;
    assert!(issued["code"].starts_with("oac_"));
    assert_eq!(issued["state"], "abc");
    assert_eq!(issued["iss"], common::BASE_URL);

    // A confidential client without PKCE works by default.
    let no_pkce = authorize(
        &h,
        &browser,
        &[
            ("client_id", client_id),
            ("redirect_uri", REDIRECT_URI),
            ("response_type", "code"),
            ("scope", "openid"),
            ("state", "s2"),
        ],
    )
    .await;
    assert!(no_pkce.contains_key("code"));

    let strict = h
        .create_app(json!({ "name": "Strict PKCE", "pkce_required": true }))
        .await;
    let missing = authorize(
        &h,
        &browser,
        &[
            ("client_id", strict["client_id"].as_str().unwrap()),
            ("redirect_uri", REDIRECT_URI),
            ("response_type", "code"),
            ("scope", "openid"),
            ("state", "s3"),
        ],
    )
    .await;
    assert_eq!(missing["error"], "invalid_request");
    assert_eq!(missing["state"], "s3");

    let plain = authorize(
        &h,
        &browser,
        &[
            ("client_id", strict["client_id"].as_str().unwrap()),
            ("redirect_uri", REDIRECT_URI),
            ("response_type", "code"),
            ("scope", "openid"),
            ("code_challenge", "abc"),
            ("code_challenge_method", "plain"),
        ],
    )
    .await;
    assert_eq!(plain["error"], "invalid_request");

    let bad_scope = authorize(
        &h,
        &browser,
        &[
            ("client_id", client_id),
            ("redirect_uri", REDIRECT_URI),
            ("response_type", "code"),
            ("scope", "openid admin"),
            ("code_challenge", &challenge_for(&pkce)),
        ],
    )
    .await;
    assert_eq!(bad_scope["error"], "invalid_scope");
    assert!(!bad_scope.contains_key("code"));

    let bad_redirect = h
        .client
        .get(
            &format!("/oauth/authorize?{}", {
                url::form_urlencoded::Serializer::new(String::new())
                    .extend_pairs([
                        ("client_id", client_id),
                        ("redirect_uri", "http://evil.example/cb"),
                        ("response_type", "code"),
                        ("scope", "openid"),
                    ])
                    .finish()
            }),
            &[("cookie", &browser.cookie)],
        )
        .await;
    assert_eq!(bad_redirect.status, StatusCode::BAD_REQUEST);
    assert_eq!(bad_redirect.value()["error"], "invalid_request");

    let unknown = h
        .client
        .get(
            &format!("/oauth/authorize?{}", {
                url::form_urlencoded::Serializer::new(String::new())
                    .extend_pairs([
                        ("client_id", "oa_nope"),
                        ("redirect_uri", REDIRECT_URI),
                        ("response_type", "code"),
                        ("scope", "openid"),
                    ])
                    .finish()
            }),
            &[],
        )
        .await;
    assert_eq!(unknown.status, StatusCode::BAD_REQUEST);

    let bad_mode = send(
        &h.router,
        Method::GET,
        &format!("/oauth/authorize?{}", {
            url::form_urlencoded::Serializer::new(String::new())
                .extend_pairs([
                    ("client_id", client_id),
                    ("redirect_uri", REDIRECT_URI),
                    ("response_type", "code"),
                    ("scope", "openid"),
                    ("response_mode", "fragment"),
                ])
                .finish()
        }),
        Body::empty(),
        &[("cookie", &browser.cookie)],
    )
    .await;
    assert_eq!(bad_mode.status, StatusCode::BAD_REQUEST);
    assert_eq!(bad_mode.value()["error"], "unsupported_response_mode");
}

#[tokio::test]
async fn token_lifecycle_userinfo_replay_and_claims() {
    let h = harness().await;
    let browser = insert_user(&h, "user@example.com").await;
    let app = h.create_app(json!({})).await;
    let flow = code_flow(&h, &browser, &app, "openid profile email offline_access").await;

    assert!(flow.tokens["access_token"]
        .as_str()
        .unwrap()
        .starts_with("oat_"));
    assert!(flow.tokens["refresh_token"]
        .as_str()
        .unwrap()
        .starts_with("ort_"));
    assert_eq!(flow.tokens["token_type"], "Bearer");
    assert_eq!(flow.tokens["expires_in"], 300);
    assert_eq!(flow.tokens["scope"], "openid profile email offline_access");

    let claims = decode_claims(flow.tokens["id_token"].as_str().unwrap());
    assert_eq!(claims["iss"], common::BASE_URL);
    assert_eq!(claims["aud"], app["client_id"]);
    assert_eq!(claims["azp"], app["client_id"]);
    assert_eq!(claims["sub"], browser.user.id);
    assert_eq!(claims["nonce"], "nonce-123");
    assert_eq!(claims["email"], "user@example.com");
    assert_eq!(claims["email_verified"], true);
    assert_eq!(claims["name"], "Ada Lovelace");
    assert_eq!(claims["given_name"], "Ada");
    assert_eq!(claims["family_name"], "Lovelace");
    assert_eq!(claims["sid"], browser.session_id);
    assert!(claims["auth_time"].is_number());

    let userinfo = h
        .client
        .get(
            "/oauth/userinfo",
            &[(
                "authorization",
                &format!("Bearer {}", flow.tokens["access_token"].as_str().unwrap()),
            )],
        )
        .await;
    assert_eq!(userinfo.status, StatusCode::OK);
    assert_eq!(userinfo.value()["sub"], browser.user.id);
    assert_eq!(userinfo.value()["email"], "user@example.com");
    assert_eq!(userinfo.value()["email_verified"], true);
    assert_eq!(userinfo.value()["name"], "Ada Lovelace");

    // POST body token and GET query token both work.
    let via_body = h
        .form(
            "/oauth/userinfo",
            &[(
                "access_token",
                flow.tokens["access_token"].as_str().unwrap(),
            )],
        )
        .await;
    assert_eq!(via_body.status, StatusCode::OK);
    let via_query = h
        .client
        .get(
            &format!(
                "/oauth/userinfo?access_token={}",
                flow.tokens["access_token"].as_str().unwrap()
            ),
            &[],
        )
        .await;
    assert_eq!(via_query.status, StatusCode::OK);

    let missing = h.client.get("/oauth/userinfo", &[]).await;
    assert_eq!(missing.status, StatusCode::UNAUTHORIZED);
    assert!(missing
        .headers
        .get("www-authenticate")
        .unwrap()
        .to_str()
        .unwrap()
        .contains("Bearer"));

    // Replaying the code fails.
    let replay = h
        .form(
            "/oauth/token",
            &[
                ("grant_type", "authorization_code"),
                ("code", &flow.code),
                ("redirect_uri", REDIRECT_URI),
                ("client_id", app["client_id"].as_str().unwrap()),
                ("client_secret", app["client_secret"].as_str().unwrap()),
            ],
        )
        .await;
    assert_eq!(replay.status, StatusCode::BAD_REQUEST);
    assert_eq!(replay.value()["error"], "invalid_grant");
}

#[tokio::test]
async fn refresh_rotates_detects_reuse_and_has_a_grace_window() {
    let h = harness().await;
    let browser = insert_user(&h, "user@example.com").await;
    let app = h.create_app(json!({})).await;
    let flow = code_flow(&h, &browser, &app, "openid email offline_access").await;
    let original = flow.tokens["refresh_token"].as_str().unwrap().to_string();
    let client_id = app["client_id"].as_str().unwrap();
    let secret = app["client_secret"].as_str().unwrap();

    let first = h
        .form(
            "/oauth/token",
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", &original),
                ("client_id", client_id),
                ("client_secret", secret),
            ],
        )
        .await;
    assert_eq!(first.status, StatusCode::OK, "{}", first.text());
    let rotated = first.value();
    assert!(rotated["refresh_token"]
        .as_str()
        .unwrap()
        .starts_with("ort_"));
    assert_ne!(rotated["refresh_token"], original);

    // Immediate retry inside the 30 s window: same successor, no extra rotation.
    let retry = h
        .form(
            "/oauth/token",
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", &original),
                ("client_id", client_id),
                ("client_secret", secret),
            ],
        )
        .await;
    assert_eq!(retry.status, StatusCode::OK);
    assert_eq!(retry.value()["refresh_token"], rotated["refresh_token"]);

    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM oauth_grants WHERE kind = 'refresh' AND application_id = $1",
    )
    .bind(app["id"].as_str().unwrap())
    .fetch_one(&h.state().pool)
    .await
    .unwrap();
    assert_eq!(count, 2);

    // Age the consumption past the grace window: the replay is theft.
    sqlx::query("UPDATE oauth_grants SET consumed_at = $1 WHERE kind = 'refresh'")
        .bind(orbitid_core::http::now() - 60_000)
        .execute(&h.state().pool)
        .await
        .unwrap();
    let reuse = h
        .form(
            "/oauth/token",
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", &original),
                ("client_id", client_id),
                ("client_secret", secret),
            ],
        )
        .await;
    assert_eq!(reuse.status, StatusCode::BAD_REQUEST);
    assert_eq!(reuse.value()["error"], "invalid_grant");

    let dead_access = h
        .client
        .get(
            "/oauth/userinfo",
            &[(
                "authorization",
                &format!("Bearer {}", rotated["access_token"].as_str().unwrap()),
            )],
        )
        .await;
    assert_eq!(dead_access.status, StatusCode::UNAUTHORIZED);
    let dead_refresh = h
        .form(
            "/oauth/token",
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", rotated["refresh_token"].as_str().unwrap()),
                ("client_id", client_id),
                ("client_secret", secret),
            ],
        )
        .await;
    assert_eq!(dead_refresh.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn refresh_scope_escalation_is_refused_and_narrowing_works() {
    let h = harness().await;
    let browser = insert_user(&h, "user@example.com").await;
    let app = h.create_app(json!({})).await;
    let flow = code_flow(&h, &browser, &app, "openid email offline_access").await;
    let refresh = flow.tokens["refresh_token"].as_str().unwrap();
    let client_id = app["client_id"].as_str().unwrap();
    let secret = app["client_secret"].as_str().unwrap();

    let escalated = h
        .form(
            "/oauth/token",
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh),
                ("scope", "openid email admin"),
                ("client_id", client_id),
                ("client_secret", secret),
            ],
        )
        .await;
    assert_eq!(escalated.status, StatusCode::BAD_REQUEST);
    assert_eq!(escalated.value()["error"], "invalid_scope");

    let narrowed = h
        .form(
            "/oauth/token",
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh),
                ("scope", "openid email"),
                ("client_id", client_id),
                ("client_secret", secret),
            ],
        )
        .await;
    assert_eq!(narrowed.status, StatusCode::OK);
    assert_eq!(narrowed.value()["scope"], "openid email");
    let info = h
        .client
        .get(
            "/oauth/userinfo",
            &[(
                "authorization",
                &format!(
                    "Bearer {}",
                    narrowed.value()["access_token"].as_str().unwrap()
                ),
            )],
        )
        .await;
    assert_eq!(info.status, StatusCode::OK);
    assert_eq!(info.value()["email"], "user@example.com");
}

#[tokio::test]
async fn token_endpoint_hardening() {
    let h = harness().await;
    let browser = insert_user(&h, "user@example.com").await;
    let app = h.create_app(json!({})).await;
    let client_id = app["client_id"].as_str().unwrap();
    let secret = app["client_secret"].as_str().unwrap();
    let verifier = pkce_verifier();
    let query = authorize(
        &h,
        &browser,
        &[
            ("client_id", client_id),
            ("redirect_uri", REDIRECT_URI),
            ("response_type", "code"),
            ("scope", "openid email"),
            ("code_challenge", &challenge_for(&verifier)),
        ],
    )
    .await;
    let code = query["code"].clone();

    // Wrong redirect_uri does not burn the code.
    let wrong_redirect = h
        .form(
            "/oauth/token",
            &[
                ("grant_type", "authorization_code"),
                ("code", &code),
                ("redirect_uri", "http://localhost:3000/other"),
                ("code_verifier", &verifier),
                ("client_id", client_id),
                ("client_secret", secret),
            ],
        )
        .await;
    assert_eq!(wrong_redirect.value()["error"], "invalid_grant");

    let wrong_verifier = h
        .form(
            "/oauth/token",
            &[
                ("grant_type", "authorization_code"),
                ("code", &code),
                ("redirect_uri", REDIRECT_URI),
                ("code_verifier", "nope"),
                ("client_id", client_id),
                ("client_secret", secret),
            ],
        )
        .await;
    assert_eq!(wrong_verifier.value()["error"], "invalid_grant");

    let no_secret = h
        .form(
            "/oauth/token",
            &[
                ("grant_type", "authorization_code"),
                ("code", &code),
                ("redirect_uri", REDIRECT_URI),
                ("code_verifier", &verifier),
                ("client_id", client_id),
            ],
        )
        .await;
    assert_eq!(no_secret.status, StatusCode::UNAUTHORIZED);
    assert!(no_secret
        .headers
        .get("www-authenticate")
        .unwrap()
        .to_str()
        .unwrap()
        .contains("Basic"));

    let wrong_secret = h
        .form(
            "/oauth/token",
            &[
                ("grant_type", "authorization_code"),
                ("code", &code),
                ("redirect_uri", REDIRECT_URI),
                ("code_verifier", &verifier),
                ("client_id", client_id),
                ("client_secret", "oas_wrong"),
            ],
        )
        .await;
    assert_eq!(wrong_secret.status, StatusCode::UNAUTHORIZED);

    let ok = h
        .form(
            "/oauth/token",
            &[
                ("grant_type", "authorization_code"),
                ("code", &code),
                ("redirect_uri", REDIRECT_URI),
                ("code_verifier", &verifier),
                ("client_id", client_id),
                ("client_secret", secret),
            ],
        )
        .await;
    assert_eq!(ok.status, StatusCode::OK);
    assert_eq!(ok.headers.get("cache-control").unwrap(), "no-store");

    let unknown_grant = h
        .form(
            "/oauth/token",
            &[
                ("grant_type", "password"),
                ("client_id", client_id),
                ("client_secret", secret),
            ],
        )
        .await;
    assert_eq!(unknown_grant.value()["error"], "unsupported_grant_type");
}

#[tokio::test]
async fn introspection_and_revocation() {
    let h = harness().await;
    let browser = insert_user(&h, "user@example.com").await;
    let app = h.create_app(json!({})).await;
    let flow = code_flow(&h, &browser, &app, "openid email offline_access").await;
    let access = flow.tokens["access_token"].as_str().unwrap();
    let refresh = flow.tokens["refresh_token"].as_str().unwrap();
    let auth = basic(
        app["client_id"].as_str().unwrap(),
        app["client_secret"].as_str().unwrap(),
    );

    let introspected = h
        .form_with_auth("/oauth/introspect", &[("token", access)], &auth)
        .await;
    assert_eq!(introspected.status, StatusCode::OK);
    let body = introspected.value();
    assert_eq!(body["active"], true);
    assert_eq!(body["client_id"], app["client_id"]);
    assert_eq!(body["sub"], browser.user.id);
    assert_eq!(body["iss"], common::BASE_URL);
    assert_eq!(body["aud"], app["client_id"]);
    assert_eq!(body["token_type"], "Bearer");

    let via_body = h
        .form(
            "/oauth/introspect",
            &[
                ("token", refresh),
                ("client_id", app["client_id"].as_str().unwrap()),
                ("client_secret", app["client_secret"].as_str().unwrap()),
            ],
        )
        .await;
    assert_eq!(via_body.value()["active"], true);
    assert_eq!(via_body.value()["token_type"], "refresh_token");

    // Anonymous and public clients cannot introspect.
    let anonymous = h.form("/oauth/introspect", &[("token", access)]).await;
    assert_eq!(anonymous.status, StatusCode::UNAUTHORIZED);
    assert_eq!(anonymous.value()["error"], "invalid_client");
    let public = h
        .create_app(json!({ "name": "Public", "public": true }))
        .await;
    let refused = h
        .form(
            "/oauth/introspect",
            &[
                ("token", access),
                ("client_id", public["client_id"].as_str().unwrap()),
            ],
        )
        .await;
    assert_eq!(refused.status, StatusCode::UNAUTHORIZED);
    assert_eq!(refused.value()["error"], "invalid_client");

    // A foreign client sees an inactive token; an unknown token is inactive.
    let other = h.create_app(json!({ "name": "Other" })).await;
    let foreign = h
        .form_with_auth(
            "/oauth/introspect",
            &[("token", access)],
            &basic(
                other["client_id"].as_str().unwrap(),
                other["client_secret"].as_str().unwrap(),
            ),
        )
        .await;
    assert_eq!(foreign.value(), json!({ "active": false }));
    let unknown = h
        .form_with_auth("/oauth/introspect", &[("token", "oat_unknown")], &auth)
        .await;
    assert_eq!(unknown.value(), json!({ "active": false }));

    // Revoking the access token kills it but not its refresh token.
    let revoked = h
        .form_with_auth("/oauth/revoke", &[("token", access)], &auth)
        .await;
    assert_eq!(revoked.status, StatusCode::OK);
    let after = h
        .client
        .get(
            "/oauth/userinfo",
            &[("authorization", &format!("Bearer {access}"))],
        )
        .await;
    assert_eq!(after.status, StatusCode::UNAUTHORIZED);
    let rotated = h
        .form(
            "/oauth/token",
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh),
                ("client_id", app["client_id"].as_str().unwrap()),
                ("client_secret", app["client_secret"].as_str().unwrap()),
            ],
        )
        .await;
    assert_eq!(rotated.status, StatusCode::OK);

    // Revoking a refresh token revokes the family.
    let rotated_refresh = rotated.value()["refresh_token"]
        .as_str()
        .unwrap()
        .to_string();
    let revoked_refresh = h
        .form_with_auth("/oauth/revoke", &[("token", &rotated_refresh)], &auth)
        .await;
    assert_eq!(revoked_refresh.status, StatusCode::OK);
    let after_refresh = h
        .form(
            "/oauth/token",
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", &rotated_refresh),
                ("client_id", app["client_id"].as_str().unwrap()),
                ("client_secret", app["client_secret"].as_str().unwrap()),
            ],
        )
        .await;
    assert_eq!(after_refresh.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn public_clients_and_client_secret_rotation() {
    let h = harness().await;
    let browser = insert_user(&h, "user@example.com").await;
    let public = h.create_app(json!({ "name": "SPA", "public": true })).await;
    assert!(public.get("client_secret").is_none());
    assert_eq!(public["pkce_required"], true);
    let flow = code_flow(&h, &browser, &public, "openid email").await;
    assert!(flow.tokens.get("refresh_token").is_none());

    let with_secret = h
        .form(
            "/oauth/token",
            &[
                ("grant_type", "authorization_code"),
                ("code", "oac_x"),
                ("redirect_uri", REDIRECT_URI),
                ("client_id", public["client_id"].as_str().unwrap()),
                ("client_secret", "nope"),
            ],
        )
        .await;
    assert_eq!(with_secret.status, StatusCode::UNAUTHORIZED);

    let confidential = h.create_app(json!({})).await;
    let rotated = h
        .client
        .post(
            &format!(
                "/v1/oauth_applications/{}/rotate_secret",
                confidential["id"].as_str().unwrap()
            ),
            None,
            common::bearer(),
        )
        .await;
    assert_eq!(rotated.status, StatusCode::OK);
    let rotated_secret = rotated.value()["client_secret"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(rotated_secret.starts_with("oas_"));
    assert_ne!(rotated_secret, confidential["client_secret"]);

    // The old secret no longer works.
    let verifier = pkce_verifier();
    let query = authorize(
        &h,
        &browser,
        &[
            ("client_id", confidential["client_id"].as_str().unwrap()),
            ("redirect_uri", REDIRECT_URI),
            ("response_type", "code"),
            ("scope", "openid"),
            ("code_challenge", &challenge_for(&verifier)),
        ],
    )
    .await;
    let old = h
        .form(
            "/oauth/token",
            &[
                ("grant_type", "authorization_code"),
                ("code", query["code"].as_str()),
                ("redirect_uri", REDIRECT_URI),
                ("code_verifier", &verifier),
                ("client_id", confidential["client_id"].as_str().unwrap()),
                (
                    "client_secret",
                    confidential["client_secret"].as_str().unwrap(),
                ),
            ],
        )
        .await;
    assert_eq!(old.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn applications_crud_is_secret_key_guarded() {
    let h = harness().await;
    let unauthorized = h.client.get("/v1/oauth_applications", &[]).await;
    assert_eq!(unauthorized.status, StatusCode::UNAUTHORIZED);

    let app = h.create_app(json!({})).await;
    assert_eq!(app["object"], "oauth_application");
    assert!(app["client_id"].as_str().unwrap().starts_with("oa_"));
    assert_eq!(app["redirect_uris"], json!([REDIRECT_URI]));
    assert_eq!(app["pkce_required"], false);
    assert_eq!(
        app["scopes"],
        "openid profile email phone groups organizations offline_access"
    );
    assert_eq!(app["groups_claim"], "none");
    assert!(app["access_token_lifetime_seconds"].as_i64().unwrap() <= 300);

    let list = h.get("/v1/oauth_applications").await;
    assert_eq!(list.status, StatusCode::OK);
    assert_eq!(list.value()["total_count"], 1);
    assert!(list.value()["data"][0].get("client_secret").is_none());

    let patched = h
        .patch(
            &format!("/v1/oauth_applications/{}", app["id"].as_str().unwrap()),
            json!({ "name": "Renamed", "redirect_uris": ["http://localhost:3000/other"] }),
        )
        .await;
    assert_eq!(patched.status, StatusCode::OK);
    assert_eq!(patched.value()["name"], "Renamed");
    assert_eq!(
        patched.value()["redirect_uris"],
        json!(["http://localhost:3000/other"])
    );

    // Empty PATCH and invalid values are 422.
    let empty = h
        .patch(
            &format!("/v1/oauth_applications/{}", app["id"].as_str().unwrap()),
            json!({}),
        )
        .await;
    assert_eq!(empty.status, StatusCode::UNPROCESSABLE_ENTITY);
    let out_of_bounds = h
        .patch(
            &format!("/v1/oauth_applications/{}", app["id"].as_str().unwrap()),
            json!({ "access_token_lifetime_seconds": 1 }),
        )
        .await;
    assert_eq!(out_of_bounds.status, StatusCode::UNPROCESSABLE_ENTITY);

    let deleted = h
        .delete(&format!(
            "/v1/oauth_applications/{}",
            app["id"].as_str().unwrap()
        ))
        .await;
    assert_eq!(deleted.value()["deleted"], true);
    let gone = h
        .get(&format!(
            "/v1/oauth_applications/{}",
            app["id"].as_str().unwrap()
        ))
        .await;
    assert_eq!(gone.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn application_scope_allowlist() {
    let h = harness().await;
    let browser = insert_user(&h, "user@example.com").await;

    let default_app = h
        .create_app(json!({ "name": "Default", "scopes": "openid profile email" }))
        .await;
    assert_eq!(default_app["scopes"], "openid profile email");
    assert_eq!(default_app["groups_claim"], "none");
    assert!(
        default_app["access_token_lifetime_seconds"]
            .as_i64()
            .unwrap()
            <= 300
    );

    for scope in [
        "openid profile email groups",
        "openid offline_access",
        "openid organizations",
        "openid custom_scope",
    ] {
        let query = authorize(
            &h,
            &browser,
            &[
                ("client_id", default_app["client_id"].as_str().unwrap()),
                ("redirect_uri", REDIRECT_URI),
                ("response_type", "code"),
                ("scope", scope),
                ("state", "s"),
            ],
        )
        .await;
        assert_eq!(query["error"], "invalid_scope", "{scope}");
        assert!(!query.contains_key("code"));
    }

    let allowed = h
        .create_app(json!({
            "scopes": "openid profile email groups offline_access",
        }))
        .await;
    let query = authorize(
        &h,
        &browser,
        &[
            ("client_id", allowed["client_id"].as_str().unwrap()),
            ("redirect_uri", REDIRECT_URI),
            ("response_type", "code"),
            ("scope", "openid profile email groups offline_access"),
        ],
    )
    .await;
    assert!(query["code"].starts_with("oac_"));

    let bare = h.create_app(json!({ "scopes": "" })).await;
    let ok = authorize(
        &h,
        &browser,
        &[
            ("client_id", bare["client_id"].as_str().unwrap()),
            ("redirect_uri", REDIRECT_URI),
            ("response_type", "code"),
            ("scope", "openid"),
        ],
    )
    .await;
    assert!(ok["code"].starts_with("oac_"));
    let refused = authorize(
        &h,
        &browser,
        &[
            ("client_id", bare["client_id"].as_str().unwrap()),
            ("redirect_uri", REDIRECT_URI),
            ("response_type", "code"),
            ("scope", "openid email"),
        ],
    )
    .await;
    assert_eq!(refused["error"], "invalid_scope");
}

#[tokio::test]
async fn consent_flow_stores_consent_and_denies_cleanly() {
    let h = harness().await;
    let browser = insert_user(&h, "user@example.com").await;
    let app = h
        .create_app(json!({ "name": "Consent App", "consent_screen_enabled": true }))
        .await;
    let client_id = app["client_id"].as_str().unwrap();
    let verifier = pkce_verifier();
    let params = [
        ("client_id", client_id),
        ("redirect_uri", REDIRECT_URI),
        ("response_type", "code"),
        ("scope", "openid profile"),
        ("state", "s1"),
        ("code_challenge", &challenge_for(&verifier)),
        ("code_challenge_method", "S256"),
    ];
    let raw = send(
        &h.router,
        Method::GET,
        &format!("/oauth/authorize?{}", {
            url::form_urlencoded::Serializer::new(String::new())
                .extend_pairs(params)
                .finish()
        }),
        Body::empty(),
        &[("cookie", &browser.cookie)],
    )
    .await;
    assert_eq!(raw.status, StatusCode::FOUND);
    let consent_location = location(&raw);
    assert!(consent_location.contains("http://localhost:3000/oauth-consent"));
    let carried = query_of(&consent_location);
    assert_eq!(carried["client_id"], client_id);
    assert_eq!(carried["scope"], "openid profile");
    let authorize_back = query_of(&carried["redirect_url"]);
    assert_eq!(authorize_back["redirect_uri"], REDIRECT_URI);
    assert_eq!(authorize_back["state"], "s1");
    assert_eq!(authorize_back["code_challenge_method"], "S256");

    let info = h
        .client
        .get(
            &format!("/oauth/consent_info?client_id={client_id}&scope=openid%20profile"),
            &[("cookie", &browser.cookie)],
        )
        .await;
    assert_eq!(info.status, StatusCode::OK);
    assert_eq!(info.value()["client"]["client_id"], client_id);
    assert_eq!(info.value()["client"]["name"], "Consent App");
    assert_eq!(info.value()["scopes"][0]["scope"], "openid");
    assert_eq!(info.value()["previously_approved"], json!([]));

    let consent = send(
        &h.router,
        Method::POST,
        "/oauth/consent",
        Body::from(
            serde_json::to_vec(&json!({
                "client_id": client_id,
                "approve": true,
                "scopes": ["openid", "profile"],
                "redirect_uri": REDIRECT_URI,
                "state": "s1",
                "code_challenge": challenge_for(&verifier),
                "code_challenge_method": "S256",
                "response_type": "code",
            }))
            .unwrap(),
        ),
        &[
            ("content-type", "application/json"),
            ("cookie", &browser.cookie),
        ],
    )
    .await;
    assert_eq!(consent.status, StatusCode::OK, "{}", consent.text());
    let redirect = query_of(consent.value()["redirect_url"].as_str().unwrap());
    assert!(redirect["code"].starts_with("oac_"));
    assert_eq!(redirect["state"], "s1");
    assert_eq!(redirect["iss"], common::BASE_URL);

    // Consent is remembered: the next authorize issues a code directly.
    let again = authorize(&h, &browser, &params).await;
    assert!(again.contains_key("code"));

    let token = h
        .form(
            "/oauth/token",
            &[
                ("grant_type", "authorization_code"),
                ("code", &redirect["code"]),
                ("redirect_uri", REDIRECT_URI),
                ("code_verifier", &verifier),
                ("client_id", client_id),
                ("client_secret", app["client_secret"].as_str().unwrap()),
            ],
        )
        .await;
    assert_eq!(token.status, StatusCode::OK);

    // Denial returns access_denied without a code.
    let denied = send(
        &h.router,
        Method::POST,
        "/oauth/consent",
        Body::from(
            serde_json::to_vec(&json!({
                "client_id": client_id,
                "approve": false,
                "redirect_uri": REDIRECT_URI,
                "state": "s9",
                "scopes": ["openid"],
            }))
            .unwrap(),
        ),
        &[
            ("content-type", "application/json"),
            ("cookie", &browser.cookie),
        ],
    )
    .await;
    assert_eq!(denied.status, StatusCode::OK);
    let redirect = query_of(denied.value()["redirect_url"].as_str().unwrap());
    assert_eq!(redirect["error"], "access_denied");
    assert!(!redirect.contains_key("code"));
    assert_eq!(redirect["state"], "s9");

    let no_session = h
        .client
        .get(
            &format!("/oauth/consent_info?client_id={client_id}&scope=openid"),
            &[],
        )
        .await;
    assert_eq!(no_session.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn organization_claims_are_scoped_and_complete() {
    let h = harness().await;
    let browser = insert_user(&h, "user@example.com").await;
    let app = h.create_app(json!({})).await;
    settings(&h, json!({ "organizations": { "enabled": true } })).await;

    let active = orbitid_identity::testing::create_test_organization(
        h.state(),
        "Active",
        None,
        &browser.user.id,
    )
    .await
    .unwrap();
    let other = orbitid_identity::testing::create_test_organization(
        h.state(),
        "Other",
        None,
        &browser.user.id,
    )
    .await
    .unwrap();
    sqlx::query("UPDATE sessions SET last_active_organization_id = $2 WHERE id = $1")
        .bind(&browser.session_id)
        .bind(&active.id)
        .execute(&h.state().pool)
        .await
        .unwrap();

    let verifier = pkce_verifier();
    let query = authorize(
        &h,
        &browser,
        &[
            ("client_id", app["client_id"].as_str().unwrap()),
            ("redirect_uri", REDIRECT_URI),
            ("response_type", "code"),
            ("scope", "openid profile email organizations"),
            ("code_challenge", &challenge_for(&verifier)),
            ("code_challenge_method", "S256"),
        ],
    )
    .await;
    let token = h
        .form(
            "/oauth/token",
            &[
                ("grant_type", "authorization_code"),
                ("code", query["code"].as_str()),
                ("redirect_uri", REDIRECT_URI),
                ("code_verifier", &verifier),
                ("client_id", app["client_id"].as_str().unwrap()),
                ("client_secret", app["client_secret"].as_str().unwrap()),
            ],
        )
        .await;
    assert_eq!(token.status, StatusCode::OK);
    let claims = decode_claims(token.value()["id_token"].as_str().unwrap());
    assert_eq!(claims["org_id"], active.id);
    assert_eq!(claims["org_role"], "org:admin");
    assert_eq!(claims["organizations"].as_array().unwrap().len(), 2);
    assert!(claims["organizations"]
        .as_array()
        .unwrap()
        .iter()
        .any(|org| org["id"] == other.id));

    let info = h
        .client
        .get(
            "/oauth/userinfo",
            &[(
                "authorization",
                &format!("Bearer {}", token.value()["access_token"].as_str().unwrap()),
            )],
        )
        .await;
    assert_eq!(info.status, StatusCode::OK);
    assert_eq!(info.value()["org_id"], active.id);
    assert_eq!(info.value()["organizations"].as_array().unwrap().len(), 2);

    // Without the scope nothing organization-related is emitted.
    let flow = code_flow(&h, &browser, &app, "openid email").await;
    let claims = decode_claims(flow.tokens["id_token"].as_str().unwrap());
    assert!(claims.get("org_id").is_none());
    assert!(claims.get("organizations").is_none());
    assert_eq!(claims["email"], "user@example.com");
}

#[tokio::test]
async fn ended_session_ends_tokens_and_grants_without_a_session_survive() {
    let h = harness().await;
    let browser = insert_user(&h, "user@example.com").await;
    let app = h.create_app(json!({})).await;
    let flow = code_flow(&h, &browser, &app, "openid email offline_access").await;

    sqlx::query("UPDATE sessions SET status = 'ended' WHERE id = $1")
        .bind(&browser.session_id)
        .execute(&h.state().pool)
        .await
        .unwrap();

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
    let introspected = h
        .form_with_auth(
            "/oauth/introspect",
            &[("token", flow.tokens["access_token"].as_str().unwrap())],
            &basic(
                app["client_id"].as_str().unwrap(),
                app["client_secret"].as_str().unwrap(),
            ),
        )
        .await;
    assert_eq!(introspected.value(), json!({ "active": false }));
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

    // A grant without a session keeps its own lifecycle.
    let now = orbitid_core::http::now();
    let access = format!("oat_{}", orbitid_core::crypto::random_token(32));
    let refresh_token = format!("ort_{}", orbitid_core::crypto::random_token(32));
    let family = orbitid_core::crypto::random_token(9);
    for (kind, token, ttl) in [
        ("access", access.as_str(), 3_600_000),
        ("refresh", refresh_token.as_str(), 86_400_000),
    ] {
        sqlx::query(
            "INSERT INTO oauth_grants (id, kind, application_id, user_id, token_hash, scopes, \
             family_id, session_id, revoked, expires_at, created_at) \
             VALUES ($1,$2,$3,$4,$5,'openid offline_access',$6,NULL,false,$7,$8)",
        )
        .bind(orbitid_core::ids::new_id(
            orbitid_core::ids::id_prefix::OAUTH_GRANT,
        ))
        .bind(kind)
        .bind(app["id"].as_str().unwrap())
        .bind(&browser.user.id)
        .bind(orbitid_core::crypto::sha256(token))
        .bind(&family)
        .bind(now + ttl)
        .bind(now)
        .execute(&h.state().pool)
        .await
        .unwrap();
    }
    let info = h
        .client
        .get(
            "/oauth/userinfo",
            &[("authorization", &format!("Bearer {access}"))],
        )
        .await;
    assert_eq!(info.status, StatusCode::OK);
    let refresh = h
        .form(
            "/oauth/token",
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", &refresh_token),
                ("client_id", app["client_id"].as_str().unwrap()),
                ("client_secret", app["client_secret"].as_str().unwrap()),
            ],
        )
        .await;
    assert_eq!(refresh.status, StatusCode::OK);
}

#[tokio::test]
async fn banned_user_stops_tokens_and_refreshes() {
    let h = harness().await;
    let browser = insert_user(&h, "user@example.com").await;
    let app = h.create_app(json!({})).await;
    let flow = code_flow(&h, &browser, &app, "openid email offline_access").await;
    sqlx::query("UPDATE users SET banned = true WHERE id = $1")
        .bind(&browser.user.id)
        .execute(&h.state().pool)
        .await
        .unwrap();
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
    assert_eq!(refresh.value()["error"], "invalid_grant");
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
}

#[tokio::test]
async fn cors_preflights_are_answered_for_oidc_endpoints() {
    let h = harness().await;
    for path in [
        "/.well-known/openid-configuration",
        "/oauth/token",
        "/oauth/userinfo",
        "/oauth/jwks",
    ] {
        let response = send(
            &h.router,
            Method::OPTIONS,
            path,
            Body::empty(),
            &[
                ("origin", "https://spa.example"),
                ("access-control-request-method", "POST"),
            ],
        )
        .await;
        assert_eq!(response.status, StatusCode::NO_CONTENT, "{path}");
        assert_eq!(
            response.headers.get("access-control-allow-origin").unwrap(),
            "*"
        );
        assert!(response
            .headers
            .get("access-control-allow-headers")
            .unwrap()
            .to_str()
            .unwrap()
            .contains("Authorization"));
        assert!(response
            .headers
            .get("access-control-allow-methods")
            .unwrap()
            .to_str()
            .unwrap()
            .contains("POST"));
    }
    // A path outside the OIDC surface is not answered by the OIDC policy.
    let other = send(
        &h.router,
        Method::OPTIONS,
        "/v1/client/me/api_keys",
        Body::empty(),
        &[("origin", "https://spa.example")],
    )
    .await;
    assert!(other.headers.get("access-control-allow-origin").is_none());
}
