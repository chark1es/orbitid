//! End-to-end walks over the fully composed HTTP server: sign-up → session JWT
//! → JWKS verification → profile; organizations and invitations; the operator
//! session → Backend API → ban path; and the OAuth authorization-code + PKCE
//! lifecycle.

mod common;

use axum::http::StatusCode;
use common::*;
use orbitid_credentials::jwt::{verify_jws, JwkSet, VerifyOptions};
use serde_json::{json, Value};

#[tokio::test]
async fn sign_up_session_jwks_and_profile_walk() {
    let e2e = E2e::new().await;
    let browser = e2e.browser();
    let signed_up = sign_up(&e2e, &browser, "walk@example.com", "Sup3r-secret!").await;
    let user_id = signed_up["response"]["created_user_id"]
        .as_str()
        .expect("created_user_id")
        .to_string();

    // The browser has a client cookie and one session.
    let client = browser.get("/v1/client", &[]).await;
    assert_eq!(client.status, StatusCode::OK, "{}", client.text());
    let session_id = client.value()["response"]["sessions"][0]["id"]
        .as_str()
        .expect("session id")
        .to_string();

    // Mint a session JWT and verify it with the public JWKS document.
    let minted = browser
        .post(
            &format!("/v1/client/sessions/{session_id}/tokens"),
            Some(json!({})),
            &[],
        )
        .await;
    assert_eq!(minted.status, StatusCode::OK, "{}", minted.text());
    let jwt = minted.value()["jwt"].as_str().expect("jwt").to_string();

    let jwks = e2e.client.get("/.well-known/jwks.json", &[]).await;
    assert_eq!(jwks.status, StatusCode::OK);
    let keys = JwkSet::from_value(&jwks.value()).expect("jwks");
    let claims = verify_jws(
        &jwt,
        &keys,
        &VerifyOptions {
            algorithms: Vec::new(),
            issuer: None,
            audience: None,
            clock_tolerance_seconds: 0,
        },
    )
    .expect("session token verifies against the published JWKS");
    assert_eq!(claims["sub"], user_id);
    assert_eq!(claims["sid"], session_id);

    // PATCH /v1/client/me updates the profile through the same session.
    let updated = browser
        .patch(
            "/v1/client/me",
            Some(json!({ "first_name": "Ada", "last_name": "Lovelace" })),
            &[],
        )
        .await;
    assert_eq!(updated.status, StatusCode::OK, "{}", updated.text());
    assert_eq!(updated.value()["response"]["first_name"], "Ada");
    assert_eq!(updated.value()["response"]["last_name"], "Lovelace");

    // The Backend API sees the same user.
    let backend = e2e
        .client
        .get(
            &format!("/v1/users/{user_id}"),
            &[("authorization", "Bearer sk_test_testsecret")],
        )
        .await;
    assert_eq!(backend.status, StatusCode::OK);
    assert_eq!(backend.value()["first_name"], "Ada");
}

#[tokio::test]
async fn organization_invitation_walk() {
    let e2e = E2e::new().await;
    e2e.state()
        .settings
        .update(json!({
            "organizations": { "enabled": true, "creationEnabled": true },
            "userSettings": { "createOrganizationEnabled": true },
        }))
        .await
        .expect("enable organizations");
    let admin = e2e.browser();
    let admin_signup = sign_up(&e2e, &admin, "admin@example.com", "Sup3r-secret!").await;
    let admin_id = admin_signup["response"]["created_user_id"]
        .as_str()
        .unwrap()
        .to_string();

    let created = admin
        .post(
            "/v1/client/organizations",
            Some(json!({ "name": "Acme" })),
            &[],
        )
        .await;
    assert_eq!(created.status, StatusCode::OK, "{}", created.text());
    let org_id = created.value()["response"]["id"]
        .as_str()
        .expect("org id")
        .to_string();

    // A second person signs up on their own browser.
    let member = e2e.browser();
    let member_signup = sign_up(&e2e, &member, "member@example.com", "Sup3r-secret!").await;
    let member_id = member_signup["response"]["created_user_id"]
        .as_str()
        .unwrap()
        .to_string();

    let invited = admin
        .post(
            &format!("/v1/client/organizations/{org_id}/invitations"),
            Some(json!({ "email_address": "member@example.com", "role": "org:member" })),
            &[],
        )
        .await;
    assert_eq!(invited.status, StatusCode::OK, "{}", invited.text());
    let invitation_id = invited.value()["response"]["id"]
        .as_str()
        .expect("invitation id")
        .to_string();
    let invitation_url = orbitid_platform::mail::latest_email(
        e2e.state(),
        "member@example.com",
        Some(orbitid_platform::mail::EmailTemplate::OrganizationInvitation),
    )
    .and_then(|email| email.vars.get("invitation_url").cloned())
    .and_then(|value| value.as_str().map(str::to_string))
    .expect("invitation link");
    assert!(invitation_url.contains("ticket="));

    let pending = member
        .get("/v1/client/me/organization_invitations", &[])
        .await;
    assert_eq!(pending.status, StatusCode::OK, "{}", pending.text());
    assert_eq!(pending.value()["response"][0]["id"], invitation_id);

    let accepted = member
        .post(
            &format!("/v1/client/me/organization_invitations/{invitation_id}/accept"),
            Some(json!({})),
            &[],
        )
        .await;
    assert_eq!(accepted.status, StatusCode::OK, "{}", accepted.text());
    assert_eq!(accepted.value()["response"]["organization"]["id"], org_id);
    assert_eq!(accepted.value()["response"]["role"], "org:member");
    assert_eq!(
        accepted.value()["response"]["public_user_data"]["user_id"],
        member_id
    );

    // Both members are visible through the organization's membership list.
    let members = admin
        .get(
            &format!("/v1/client/organizations/{org_id}/memberships"),
            &[],
        )
        .await;
    assert_eq!(members.status, StatusCode::OK);
    let members_body = members.value();
    let ids: Vec<String> = members_body["response"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|member| {
            member["public_user_data"]["user_id"]
                .as_str()
                .map(str::to_string)
        })
        .collect();
    assert!(ids.iter().any(|id| id == &admin_id), "{ids:?}");
    assert!(ids.iter().any(|id| id == &member_id), "{ids:?}");
}

#[tokio::test]
async fn operator_session_search_ban_and_session_death() {
    let e2e = E2e::new().await;
    let victim = e2e.browser();
    let signup = sign_up(&e2e, &victim, "victim@example.com", "Sup3r-secret!").await;
    let user_id = signup["response"]["created_user_id"]
        .as_str()
        .unwrap()
        .to_string();

    let exchanged = e2e
        .client
        .post(
            "/v1/operator_sessions",
            Some(json!({ "secret_key": SECRET_KEY })),
            &[],
        )
        .await;
    assert_eq!(
        exchanged.status,
        StatusCode::CREATED,
        "{}",
        exchanged.text()
    );
    let operator = cookie_pair(&exchanged, "__orbit_operator").expect("operator cookie");

    let listed = e2e
        .client
        .get(
            &format!("/v1/users?query={user_id}"),
            &[("cookie", operator.as_str())],
        )
        .await;
    assert_eq!(listed.status, StatusCode::OK, "{}", listed.text());
    assert_eq!(listed.value().as_array().unwrap().len(), 1);
    assert_eq!(listed.value()[0]["id"], user_id);

    let banned = e2e
        .client
        .post(
            &format!("/v1/users/{user_id}/ban"),
            None,
            &[("cookie", operator.as_str())],
        )
        .await;
    assert_eq!(banned.status, StatusCode::OK, "{}", banned.text());
    assert_eq!(banned.value()["banned"], true);

    // Banning revoked the session: the browser's own credential is dead.
    let me = victim.get("/v1/client/me", &[]).await;
    assert_eq!(me.status, StatusCode::UNAUTHORIZED, "{}", me.text());
}

#[tokio::test]
async fn oauth_authorization_code_pkce_walk() {
    let e2e = E2e::new().await;
    // No grace window, so replaying the spent refresh token is detected at once.
    e2e.state()
        .settings
        .update(json!({ "oidcProvider": { "refreshTokenReuseGraceSeconds": 0 } }))
        .await
        .expect("tighten refresh grace");
    let browser = e2e.browser();
    sign_up(&e2e, &browser, "oauth@example.com", "Sup3r-secret!").await;

    // Create the application through the Backend API.
    let application = e2e
        .client
        .post(
            "/v1/oauth_applications",
            Some(json!({
                "name": "Walk App",
                "redirect_uris": [REDIRECT_URI],
                "post_logout_redirect_uris": ["http://localhost:3000/sign_out"],
                "consent_screen_enabled": false,
                "scopes": "openid profile email offline_access",
            })),
            &[("authorization", "Bearer sk_test_testsecret")],
        )
        .await;
    assert_eq!(
        application.status,
        StatusCode::CREATED,
        "{}",
        application.text()
    );
    let app: Value = application.value();
    let client_id = app["client_id"].as_str().unwrap().to_string();
    let client_secret = app["client_secret"].as_str().unwrap().to_string();

    let verifier = pkce_verifier();
    let challenge = challenge_for(&verifier);
    let query = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs([
            ("client_id", client_id.as_str()),
            ("redirect_uri", REDIRECT_URI),
            ("response_type", "code"),
            ("scope", "openid profile email offline_access"),
            ("state", "state-1"),
            ("nonce", "nonce-1"),
            ("code_challenge", challenge.as_str()),
            ("code_challenge_method", "S256"),
        ])
        .finish();
    let authorize = browser.get(&format!("/oauth/authorize?{query}"), &[]).await;
    assert_eq!(authorize.status, StatusCode::FOUND, "{}", authorize.text());
    let redirect = query_of(&location(&authorize));
    let code = redirect.get("code").expect("authorization code").clone();
    assert_eq!(redirect.get("state").map(String::as_str), Some("state-1"));

    let tokens = e2e
        .form(
            &browser,
            "/oauth/token",
            &[
                ("grant_type", "authorization_code"),
                ("code", code.as_str()),
                ("redirect_uri", REDIRECT_URI),
                ("code_verifier", verifier.as_str()),
                ("client_id", client_id.as_str()),
                ("client_secret", client_secret.as_str()),
            ],
        )
        .await;
    assert_eq!(tokens.status, StatusCode::OK, "{}", tokens.text());
    let tokens = tokens.value();
    let access = tokens["access_token"].as_str().unwrap().to_string();
    let refresh = tokens["refresh_token"].as_str().unwrap().to_string();
    let id_token = tokens["id_token"].as_str().unwrap().to_string();

    let userinfo = e2e
        .client
        .get(
            "/oauth/userinfo",
            &[("authorization", &format!("Bearer {access}"))],
        )
        .await;
    assert_eq!(userinfo.status, StatusCode::OK, "{}", userinfo.text());
    assert_eq!(userinfo.value()["email"], "oauth@example.com");
    assert_eq!(userinfo.value()["email_verified"], true);

    // Refresh rotation: the old token is spent, the new one works.
    let refreshed = e2e
        .form(
            &browser,
            "/oauth/token",
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh.as_str()),
                ("client_id", client_id.as_str()),
                ("client_secret", client_secret.as_str()),
            ],
        )
        .await;
    assert_eq!(refreshed.status, StatusCode::OK, "{}", refreshed.text());
    let rotated = refreshed.value()["refresh_token"]
        .as_str()
        .unwrap()
        .to_string();
    assert_ne!(rotated, refresh);

    let replay = e2e
        .form(
            &browser,
            "/oauth/token",
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh.as_str()),
                ("client_id", client_id.as_str()),
                ("client_secret", client_secret.as_str()),
            ],
        )
        .await;
    assert_eq!(replay.status, StatusCode::BAD_REQUEST, "{}", replay.text());

    // End the session through RP-initiated logout; the access token dies with it.
    let logout = browser
        .get(
            &format!(
                "/oauth/end_session?{}",
                url::form_urlencoded::Serializer::new(String::new())
                    .extend_pairs([
                        ("id_token_hint", id_token.as_str()),
                        ("post_logout_redirect_uri", "http://localhost:3000/sign_out"),
                    ])
                    .finish()
            ),
            &[],
        )
        .await;
    assert_eq!(logout.status, StatusCode::FOUND, "{}", logout.text());
    let after = e2e
        .client
        .get(
            "/oauth/userinfo",
            &[("authorization", &format!("Bearer {access}"))],
        )
        .await;
    assert_eq!(after.status, StatusCode::UNAUTHORIZED);
}
