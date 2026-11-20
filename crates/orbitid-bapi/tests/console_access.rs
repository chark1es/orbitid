//! Account-based console access: first-run owner setup, opening the console
//! from a signed-in account, and the request-time checks that end it.

mod common;

use axum::http::StatusCode;
use orbitid_core::testing::TestResponse;
use serde_json::{json, Value};

use common::{error_code, setup, Harness};

const PASSWORD: &str = "correct horse battery staple";

/// `name=value` from the response's `Set-Cookie` for `name`, when it sets one.
fn cookie_pair(response: &TestResponse, name: &str) -> Option<String> {
    response
        .headers
        .get_all(axum::http::header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find(|value| value.starts_with(&format!("{name}=")))
        .and_then(|value| value.split(';').next())
        .map(str::to_string)
}

async fn status(harness: &Harness, cookies: &str) -> Value {
    let response = harness
        .client
        .get("/v1/operator_sessions/status", &[("cookie", cookies)])
        .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    response.value()
}

async fn setup_owner(harness: &Harness, email: &str) -> TestResponse {
    harness
        .client
        .post(
            "/v1/operator_sessions/setup",
            Some(json!({ "email_address": email, "password": PASSWORD, "first_name": "Ada" })),
            &[],
        )
        .await
}

/// Both cookies the setup response sets, joined for a `Cookie` header.
fn cookies_of(response: &TestResponse) -> String {
    let client = cookie_pair(response, "__client").expect("client cookie");
    let operator = cookie_pair(response, "__orbit_operator").expect("operator cookie");
    format!("{client}; {operator}")
}

#[tokio::test]
async fn a_fresh_instance_asks_for_its_owner() {
    let harness = setup().await;
    let body = status(&harness, "").await;
    assert_eq!(body["setup_required"], true);
    assert_eq!(body["console_unclaimed"], false);
    assert!(body["user"].is_null());
    assert!(body["operator_session"].is_null());
}

/// Accounts from before owners: no setup, and nobody can open the console
/// until the server grants the Owner role (`orbitid owner <email>`).
#[tokio::test]
async fn an_instance_without_owners_is_claimed_from_the_server() {
    use orbitid_identity::console::{grant_owner, OwnerGrant};

    let harness = setup().await;
    let user = harness
        .create_user(json!({ "email_address": ["existing@example.com"], "password": PASSWORD }))
        .await;
    let user_id = user["id"].as_str().unwrap().to_string();
    harness
        .put(
            &format!("/v1/users/{user_id}/roles"),
            json!({ "roles": [] }),
        )
        .await;
    let body = status(&harness, "").await;
    assert_eq!(body["setup_required"], false);
    assert_eq!(body["console_unclaimed"], true);

    // Unknown and unverified addresses are refused.
    assert!(grant_owner(harness.state(), "nobody@example.com")
        .await
        .is_err());
    let unverified = harness
        .create_user(json!({ "email_address": ["unverified@example.com"], "skip_password_requirement": true }))
        .await;
    let unverified_id = unverified["id"].as_str().unwrap();
    sqlx::query("UPDATE email_addresses SET verified = false WHERE user_id = $1")
        .bind(unverified_id)
        .execute(&harness.state().pool)
        .await
        .unwrap();
    assert!(grant_owner(harness.state(), "unverified@example.com")
        .await
        .is_err());

    // A custom role the account already holds is kept.
    harness
        .post(
            "/v1/roles",
            json!({ "key": "app:support", "name": "Support", "permissions": [] }),
        )
        .await;
    harness
        .put(
            &format!("/v1/users/{user_id}/roles"),
            json!({ "roles": ["app:support"] }),
        )
        .await;
    let granted = grant_owner(harness.state(), "Existing@Example.com")
        .await
        .unwrap();
    assert!(matches!(granted, OwnerGrant::Granted(ref row) if row.id == user_id));
    let roles = harness.get(&format!("/v1/users/{user_id}/roles")).await;
    assert!(roles.text().contains("app:sys_owner"), "{}", roles.text());
    assert!(roles.text().contains("app:support"), "{}", roles.text());
    assert!(matches!(
        grant_owner(harness.state(), &user_id).await.unwrap(),
        OwnerGrant::AlreadyOwner(_)
    ));
    assert_eq!(status(&harness, "").await["console_unclaimed"], false);

    // The new owner opens the console from its own sign-in.
    let fixture = harness.create_session(&user_id).await;
    let opened = harness
        .client
        .post(
            "/v1/operator_sessions/from_user",
            None,
            &[("cookie", &format!("__client={}", fixture.token))],
        )
        .await;
    assert_eq!(opened.status, StatusCode::CREATED, "{}", opened.text());
}

#[tokio::test]
async fn setup_creates_the_owner_signs_it_in_and_opens_the_console() {
    let harness = setup().await;
    let response = setup_owner(&harness, "Owner@Example.com").await;
    assert_eq!(response.status, StatusCode::CREATED, "{}", response.text());
    let body = response.value();
    assert_eq!(body["setup_required"], false);
    assert_eq!(body["user"]["email_address"], "owner@example.com");
    assert_eq!(body["user"]["console_access"], true);
    assert_eq!(body["operator_session"]["user_id"], body["user"]["id"]);
    assert!(!response.text().contains(PASSWORD));

    let cookies = cookies_of(&response);
    // The console cookie authenticates the Backend API like a key exchange does.
    let read = harness.cookie("/v1/instance", &cookies).await;
    assert_eq!(read.status, StatusCode::OK, "{}", read.text());

    // The owner holds the seeded Owner role, so the console survives a reload.
    let user_id = body["user"]["id"].as_str().unwrap().to_string();
    let roles = harness.get(&format!("/v1/users/{user_id}/roles")).await;
    assert!(roles.text().contains("app:sys_owner"), "{}", roles.text());
    let again = status(&harness, &cookies).await;
    assert_eq!(again["setup_required"], false);
    assert_eq!(again["user"]["id"], user_id.as_str());
    assert_eq!(again["operator_session"]["user_id"], user_id.as_str());
}

#[tokio::test]
async fn setup_is_closed_once_an_account_exists() {
    let harness = setup().await;
    assert_eq!(
        setup_owner(&harness, "first@example.com").await.status,
        StatusCode::CREATED
    );
    let second = setup_owner(&harness, "second@example.com").await;
    assert_eq!(second.status, StatusCode::FORBIDDEN);
    assert!(cookie_pair(&second, "__orbit_operator").is_none());

    // An instance that already has users (an upgrade) never offers setup.
    let upgraded = setup().await;
    upgraded
        .create_user(json!({ "email_address": ["existing@example.com"], "password": PASSWORD }))
        .await;
    assert_eq!(status(&upgraded, "").await["setup_required"], false);
    assert_eq!(
        setup_owner(&upgraded, "intruder@example.com").await.status,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn concurrent_setups_make_exactly_one_owner() {
    let harness = setup().await;
    let (a, b) = tokio::join!(
        setup_owner(&harness, "a@example.com"),
        setup_owner(&harness, "b@example.com")
    );
    let created = [a.status, b.status]
        .iter()
        .filter(|status| **status == StatusCode::CREATED)
        .count();
    assert_eq!(created, 1, "{} / {}", a.text(), b.text());
    let owners: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM user_roles WHERE role_key = 'app:sys_owner'")
            .fetch_one(&harness.state().pool)
            .await
            .unwrap();
    assert_eq!(owners, 1);
}

#[tokio::test]
async fn setup_checks_origin_email_and_password_policy() {
    let harness = setup().await;
    let cross = harness
        .client
        .post(
            "/v1/operator_sessions/setup",
            Some(json!({ "email_address": "a@example.com", "password": PASSWORD })),
            &[("origin", "https://evil.example")],
        )
        .await;
    assert_eq!(cross.status, StatusCode::FORBIDDEN);

    let bad_email = harness
        .client
        .post(
            "/v1/operator_sessions/setup",
            Some(json!({ "email_address": "not-an-email", "password": PASSWORD })),
            &[],
        )
        .await;
    assert_eq!(bad_email.status, StatusCode::UNPROCESSABLE_ENTITY);

    let weak = harness
        .client
        .post(
            "/v1/operator_sessions/setup",
            Some(json!({ "email_address": "a@example.com", "password": "short" })),
            &[],
        )
        .await;
    assert_eq!(
        weak.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{}",
        weak.text()
    );
    // Nothing was created, so setup is still open.
    assert_eq!(status(&harness, "").await["setup_required"], true);
}

#[tokio::test]
async fn an_account_opens_the_console_only_while_a_role_grants_it() {
    let harness = setup().await;
    let user = harness
        .create_user(json!({ "email_address": ["member@example.com"], "password": PASSWORD }))
        .await;
    let user_id = user["id"].as_str().unwrap().to_string();
    let fixture = harness.create_session(&user_id).await;
    let client = format!("__client={}", fixture.token);

    let signed_in = status(&harness, &client).await;
    assert_eq!(signed_in["user"]["id"], user_id.as_str());
    assert_eq!(signed_in["user"]["console_access"], false);
    assert!(signed_in["operator_session"].is_null());

    let refused = harness
        .client
        .post(
            "/v1/operator_sessions/from_user",
            None,
            &[("cookie", &client)],
        )
        .await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN);
    assert!(cookie_pair(&refused, "__orbit_operator").is_none());

    let granted = harness
        .put(
            &format!("/v1/users/{user_id}/roles"),
            json!({ "roles": ["app:sys_admin"] }),
        )
        .await;
    assert_eq!(granted.status, StatusCode::OK, "{}", granted.text());
    assert_eq!(
        status(&harness, &client).await["user"]["console_access"],
        true
    );

    let opened = harness
        .client
        .post(
            "/v1/operator_sessions/from_user",
            None,
            &[("cookie", &client)],
        )
        .await;
    assert_eq!(opened.status, StatusCode::CREATED, "{}", opened.text());
    // The answer names the account the console belongs to.
    assert_eq!(opened.value()["user"]["id"], user_id.as_str());
    assert_eq!(
        opened.value()["operator_session"]["user_id"],
        user_id.as_str()
    );
    let operator = cookie_pair(&opened, "__orbit_operator").expect("operator cookie");
    assert_eq!(
        harness.cookie("/v1/users", &operator).await.status,
        StatusCode::OK
    );

    // Taking the role away ends the console on the next request.
    harness
        .put(
            &format!("/v1/users/{user_id}/roles"),
            json!({ "roles": [] }),
        )
        .await;
    let after = harness.cookie("/v1/users", &operator).await;
    assert_eq!(after.status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        error_code(&after).as_deref(),
        Some("authentication_invalid")
    );
}

#[tokio::test]
async fn the_console_ends_with_the_account_session_and_a_ban() {
    let harness = setup().await;
    let created = setup_owner(&harness, "owner@example.com").await;
    let cookies = cookies_of(&created);
    let operator = cookie_pair(&created, "__orbit_operator").unwrap();
    let user_id = created.value()["user"]["id"].as_str().unwrap().to_string();

    // A ban ends it.
    let banned = harness
        .post_empty(&format!("/v1/users/{user_id}/ban"))
        .await;
    assert_eq!(banned.status, StatusCode::OK, "{}", banned.text());
    assert_eq!(
        harness.cookie("/v1/users", &operator).await.status,
        StatusCode::UNAUTHORIZED
    );
    harness
        .post_empty(&format!("/v1/users/{user_id}/unban"))
        .await;

    // Ending the account's own session ends it too, even after the ban is lifted.
    let session_id: String =
        sqlx::query_scalar("SELECT session_id FROM operator_sessions WHERE user_id = $1")
            .bind(&user_id)
            .fetch_one(&harness.state().pool)
            .await
            .unwrap();
    sqlx::query("UPDATE sessions SET status = 'ended' WHERE id = $1")
        .bind(&session_id)
        .execute(&harness.state().pool)
        .await
        .unwrap();
    assert_eq!(
        harness.cookie("/v1/users", &operator).await.status,
        StatusCode::UNAUTHORIZED
    );
    let body = status(&harness, &cookies).await;
    assert!(body["operator_session"].is_null());
    assert!(body["user"].is_null());
}

#[tokio::test]
async fn signing_out_of_an_account_console_signs_the_account_out_too() {
    let harness = setup().await;
    let created = setup_owner(&harness, "owner@example.com").await;
    let cookies = cookies_of(&created);
    let out = harness
        .client
        .delete(
            "/v1/operator_sessions/current",
            None,
            &[("cookie", &cookies)],
        )
        .await;
    assert_eq!(out.status, StatusCode::NO_CONTENT, "{}", out.text());
    let body = status(&harness, &cookies).await;
    assert!(body["operator_session"].is_null());
    assert!(body["user"].is_null(), "{body}");
}

#[tokio::test]
async fn signing_out_without_a_console_leaves_the_account_alone_unless_asked() {
    let harness = setup().await;
    let user = harness
        .create_user(json!({ "email_address": ["member@example.com"], "password": PASSWORD }))
        .await;
    let fixture = harness.create_session(user["id"].as_str().unwrap()).await;
    let client = format!("__client={}", fixture.token);

    let out = harness
        .client
        .delete(
            "/v1/operator_sessions/current",
            None,
            &[("cookie", &client)],
        )
        .await;
    assert_eq!(out.status, StatusCode::NO_CONTENT);
    assert!(!status(&harness, &client).await["user"].is_null());

    let out = harness
        .client
        .delete(
            "/v1/operator_sessions/current?account=true",
            None,
            &[("cookie", &client)],
        )
        .await;
    assert_eq!(out.status, StatusCode::NO_CONTENT);
    assert!(status(&harness, &client).await["user"].is_null());
}

#[tokio::test]
async fn status_refuses_cross_origin_reads() {
    let harness = setup().await;
    let response = harness
        .client
        .get(
            "/v1/operator_sessions/status",
            &[
                ("origin", "https://evil.example"),
                ("sec-fetch-site", "cross-site"),
            ],
        )
        .await;
    assert_eq!(response.status, StatusCode::FORBIDDEN);
}

/// Claiming is permanent: deleting every account later does not reopen setup.
#[tokio::test]
async fn setup_stays_closed_after_every_account_is_deleted() {
    let harness = setup().await;
    let created = setup_owner(&harness, "owner@example.com").await;
    assert_eq!(created.status, StatusCode::CREATED);
    let user_id = created.value()["user"]["id"].as_str().unwrap().to_string();
    let deleted = harness.delete(&format!("/v1/users/{user_id}")).await;
    assert_eq!(deleted.status, StatusCode::OK, "{}", deleted.text());

    assert_eq!(status(&harness, "").await["setup_required"], false);
    let again = setup_owner(&harness, "intruder@example.com").await;
    assert_eq!(again.status, StatusCode::FORBIDDEN);
    assert!(cookie_pair(&again, "__orbit_operator").is_none());
}

/// Only this browser's own `__client` cookie can open the console: a session
/// JWT an application received, a client token as a bearer, or a session-id
/// hint cannot be exchanged for Backend API access.
#[tokio::test]
async fn tokens_from_outside_this_browser_cannot_open_the_console() {
    let harness = setup().await;
    let user = harness
        .create_user(json!({ "email_address": ["admin@example.com"], "password": PASSWORD }))
        .await;
    let user_id = user["id"].as_str().unwrap().to_string();
    harness
        .put(
            &format!("/v1/users/{user_id}/roles"),
            json!({ "roles": ["app:sys_admin"] }),
        )
        .await;
    let fixture = harness.create_session(&user_id).await;
    let jwt = orbitid_identity::tokens::sign_session_token(
        harness.state(),
        &fixture.session_id,
        orbitid_identity::tokens::SignSessionTokenOptions {
            template: None,
            azp: None,
        },
    )
    .await
    .expect("jwt");

    for headers in [
        vec![("authorization".to_string(), format!("Bearer {jwt}"))],
        vec![(
            "authorization".to_string(),
            format!("Bearer {}", fixture.token),
        )],
        vec![(
            "x-orbitid-session-id".to_string(),
            fixture.session_id.clone(),
        )],
    ] {
        let pairs: Vec<(&str, &str)> = headers
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
            .collect();
        let refused = harness
            .client
            .post("/v1/operator_sessions/from_user", None, &pairs)
            .await;
        assert_eq!(refused.status, StatusCode::UNAUTHORIZED, "{headers:?}");
        assert!(cookie_pair(&refused, "__orbit_operator").is_none());
    }
    // The browser's own cookie still works.
    let opened = harness
        .client
        .post(
            "/v1/operator_sessions/from_user",
            None,
            &[("cookie", &format!("__client={}", fixture.token))],
        )
        .await;
    assert_eq!(opened.status, StatusCode::CREATED, "{}", opened.text());
}

/// Cutting an account off ends its console sessions for good: giving the role
/// back later does not revive the old cookie.
#[tokio::test]
async fn restoring_access_does_not_revive_a_cut_off_console() {
    let harness = setup().await;
    let created = setup_owner(&harness, "owner@example.com").await;
    let operator = cookie_pair(&created, "__orbit_operator").unwrap();
    let user_id = created.value()["user"]["id"].as_str().unwrap().to_string();

    harness
        .put(
            &format!("/v1/users/{user_id}/roles"),
            json!({ "roles": [] }),
        )
        .await;
    harness
        .put(
            &format!("/v1/users/{user_id}/roles"),
            json!({ "roles": ["app:sys_owner"] }),
        )
        .await;
    assert_eq!(
        harness.cookie("/v1/users", &operator).await.status,
        StatusCode::UNAUTHORIZED
    );
}

/// Working in the console counts as activity on the account session, so an
/// inactivity timeout does not sign an active operator out.
#[tokio::test]
async fn console_requests_keep_the_account_session_active() {
    let harness = setup().await;
    let created = setup_owner(&harness, "owner@example.com").await;
    let operator = cookie_pair(&created, "__orbit_operator").unwrap();
    harness
        .state()
        .settings
        .update(json!({ "session": { "inactivityTimeoutSeconds": 600 } }))
        .await
        .expect("settings");
    let session_id: String = sqlx::query_scalar("SELECT session_id FROM operator_sessions")
        .fetch_one(&harness.state().pool)
        .await
        .unwrap();
    // Five minutes idle: still inside the timeout, but due for a refresh.
    let stale = orbitid_core::http::now() - 5 * 60_000;
    sqlx::query("UPDATE sessions SET last_active_at = $1 WHERE id = $2")
        .bind(stale)
        .bind(&session_id)
        .execute(&harness.state().pool)
        .await
        .unwrap();

    assert_eq!(
        harness.cookie("/v1/users", &operator).await.status,
        StatusCode::OK
    );
    let touched: i64 = sqlx::query_scalar("SELECT last_active_at FROM sessions WHERE id = $1")
        .bind(&session_id)
        .fetch_one(&harness.state().pool)
        .await
        .unwrap();
    assert!(touched > stale + 60_000, "{touched} vs {stale}");
}

/// Signing out of a console whose session already expired still signs the
/// account out, instead of reporting success and leaving it signed in.
#[tokio::test]
async fn signing_out_after_the_console_expired_signs_the_account_out() {
    let harness = setup().await;
    let created = setup_owner(&harness, "owner@example.com").await;
    let cookies = cookies_of(&created);
    sqlx::query("UPDATE operator_sessions SET expires_at = $1")
        .bind(orbitid_core::http::now() - 1)
        .execute(&harness.state().pool)
        .await
        .unwrap();
    let out = harness
        .client
        .delete(
            "/v1/operator_sessions/current",
            None,
            &[("cookie", &cookies)],
        )
        .await;
    assert_eq!(out.status, StatusCode::NO_CONTENT, "{}", out.text());
    assert!(status(&harness, &cookies).await["user"].is_null());
}

/// The first real account claims the instance, however it is created: an
/// instance that ever had users never offers setup again, even once they are
/// all deleted. Guests do not count.
#[tokio::test]
async fn the_first_real_account_claims_the_instance_and_guests_do_not() {
    let harness = setup().await;
    orbitid_identity::testing::create_test_guest(harness.state())
        .await
        .unwrap();
    assert_eq!(status(&harness, "").await["setup_required"], true);

    let user = harness
        .create_user(json!({ "email_address": ["first@example.com"], "password": PASSWORD }))
        .await;
    let user_id = user["id"].as_str().unwrap();
    assert_eq!(
        harness.delete(&format!("/v1/users/{user_id}")).await.status,
        StatusCode::OK
    );
    assert_eq!(status(&harness, "").await["setup_required"], false);
    assert_eq!(
        setup_owner(&harness, "late@example.com").await.status,
        StatusCode::FORBIDDEN
    );
}

/// Console access belongs to the Owner and Administrator system roles only, so
/// editing a custom role can never grant it (or quietly restore it).
#[tokio::test]
async fn a_custom_role_cannot_carry_console_access() {
    let harness = setup().await;
    let created = harness
        .post(
            "/v1/roles",
            json!({ "key": "app:ops", "name": "Ops", "permissions": ["app:sys_dashboard:access"] }),
        )
        .await;
    assert_eq!(
        created.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{}",
        created.text()
    );
    let role = harness
        .post("/v1/roles", json!({ "key": "app:ops", "name": "Ops" }))
        .await;
    assert_eq!(role.status, StatusCode::OK, "{}", role.text());
    let role_id = role.value()["id"].as_str().unwrap().to_string();
    let updated = harness
        .post(
            &format!("/v1/roles/{role_id}/permissions"),
            json!({ "permissions": ["app:sys_dashboard:access"] }),
        )
        .await;
    assert_eq!(
        updated.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{}",
        updated.text()
    );
}

/// A sub-minute inactivity timeout still keeps an active operator signed in.
#[tokio::test]
async fn console_activity_is_refreshed_within_a_short_inactivity_timeout() {
    let harness = setup().await;
    let created = setup_owner(&harness, "owner@example.com").await;
    let operator = cookie_pair(&created, "__orbit_operator").unwrap();
    harness
        .state()
        .settings
        .update(json!({ "session": { "inactivityTimeoutSeconds": 30 } }))
        .await
        .expect("settings");
    let session_id: String = sqlx::query_scalar("SELECT session_id FROM operator_sessions")
        .fetch_one(&harness.state().pool)
        .await
        .unwrap();
    let stale = orbitid_core::http::now() - 20_000;
    sqlx::query("UPDATE sessions SET last_active_at = $1 WHERE id = $2")
        .bind(stale)
        .bind(&session_id)
        .execute(&harness.state().pool)
        .await
        .unwrap();
    assert_eq!(
        harness.cookie("/v1/users", &operator).await.status,
        StatusCode::OK
    );
    let touched: i64 = sqlx::query_scalar("SELECT last_active_at FROM sessions WHERE id = $1")
        .bind(&session_id)
        .fetch_one(&harness.state().pool)
        .await
        .unwrap();
    assert!(touched > stale + 10_000, "{touched} vs {stale}");
}

/// Winning the claim is what makes setup create the owner: if the first
/// account's claim is in flight (a concurrent sign-up), setup waits for it and
/// gives up once it commits, instead of minting an Owner beside it.
#[tokio::test]
async fn setup_loses_to_a_first_account_that_claims_while_it_runs() {
    let harness = setup().await;
    // A sign-up's `users` trigger, caught between its claim and its commit.
    let mut signup = harness.state().pool.begin().await.unwrap();
    sqlx::query("INSERT INTO console_owner_setup (id, claimed_at) VALUES ('default', 1)")
        .execute(&mut *signup)
        .await
        .unwrap();

    let request = setup_owner(&harness, "late-owner@example.com");
    let commit = async {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        signup.commit().await.unwrap();
    };
    let (response, ()) = tokio::join!(request, commit);
    assert_eq!(
        response.status,
        StatusCode::FORBIDDEN,
        "{}",
        response.text()
    );
    assert!(cookie_pair(&response, "__orbit_operator").is_none());
    let owners: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM user_roles WHERE role_key = 'app:sys_owner'")
            .fetch_one(&harness.state().pool)
            .await
            .unwrap();
    assert_eq!(owners, 0);
}

/// With a console open, status reports the account that opened it, even after
/// the browser switched its active account (multi-session).
#[tokio::test]
async fn status_names_the_console_account_after_a_session_switch() {
    let harness = setup().await;
    let created = setup_owner(&harness, "owner@example.com").await;
    let cookies = cookies_of(&created);
    let owner_id = created.value()["user"]["id"].as_str().unwrap().to_string();
    let other = harness
        .create_user(json!({ "email_address": ["other@example.com"], "password": PASSWORD }))
        .await;
    let other_id = other["id"].as_str().unwrap().to_string();
    let client_id: String = sqlx::query_scalar(
        "SELECT s.client_id FROM sessions s JOIN operator_sessions o ON o.session_id = s.id",
    )
    .fetch_one(&harness.state().pool)
    .await
    .unwrap();
    let now = orbitid_core::http::now();
    let switched = orbitid_core::ids::new_id(orbitid_core::ids::id_prefix::SESSION);
    sqlx::query(
        "INSERT INTO sessions (id, client_id, user_id, status, last_active_at, expire_at, \
         abandon_at, created_at, updated_at) VALUES ($1,$2,$3,'active',$4,$5,$5,$4,$4)",
    )
    .bind(&switched)
    .bind(&client_id)
    .bind(&other_id)
    .bind(now)
    .bind(now + 3_600_000)
    .execute(&harness.state().pool)
    .await
    .unwrap();
    sqlx::query("UPDATE clients SET last_active_session_id = $1 WHERE id = $2")
        .bind(&switched)
        .bind(&client_id)
        .execute(&harness.state().pool)
        .await
        .unwrap();

    let body = status(&harness, &cookies).await;
    assert_eq!(body["operator_session"]["user_id"], owner_id.as_str());
    assert_eq!(body["user"]["id"], owner_id.as_str());
}

/// A guest becoming a real account while owner setup holds the claim never
/// waits on it, so the two cannot deadlock (for example on the same email).
#[tokio::test]
async fn a_guest_upgrade_does_not_wait_on_owner_setup() {
    let harness = setup().await;
    let guest = orbitid_identity::testing::create_test_guest(harness.state())
        .await
        .unwrap();
    // Owner setup, caught between its claim and its commit.
    let mut setup_tx = harness.state().pool.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext('orbitid_owner_setup')::bigint)")
        .execute(&mut *setup_tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO console_owner_setup (id, claimed_at) VALUES ('default', 1)")
        .execute(&mut *setup_tx)
        .await
        .unwrap();

    let mut upgrade = harness.state().pool.begin().await.unwrap();
    sqlx::query("SET LOCAL statement_timeout = '3s'")
        .execute(&mut *upgrade)
        .await
        .unwrap();
    sqlx::query("UPDATE users SET is_anonymous = false WHERE id = $1")
        .bind(&guest.id)
        .execute(&mut *upgrade)
        .await
        .expect("the upgrade must not wait for owner setup");
    upgrade.commit().await.unwrap();
    setup_tx.commit().await.unwrap();
}

#[tokio::test]
async fn a_guest_cannot_be_made_owner() {
    let harness = setup().await;
    let guest = orbitid_identity::testing::create_test_guest(harness.state())
        .await
        .unwrap();
    assert!(
        orbitid_identity::console::grant_owner(harness.state(), &guest.id)
            .await
            .is_err()
    );
}

/// After a multi-session switch, signing out ends both accounts: the one that
/// opened the console (even once its console row was revoked for losing
/// access) and the one the browser shows now.
#[tokio::test]
async fn signing_out_after_a_switch_ends_both_accounts() {
    let harness = setup().await;
    let created = setup_owner(&harness, "owner@example.com").await;
    let cookies = cookies_of(&created);
    let owner_id = created.value()["user"]["id"].as_str().unwrap().to_string();
    let (owner_session, client_id): (String, String) = sqlx::query_as(
        "SELECT s.id, s.client_id FROM sessions s JOIN operator_sessions o ON o.session_id = s.id",
    )
    .fetch_one(&harness.state().pool)
    .await
    .unwrap();
    let other = harness
        .create_user(json!({ "email_address": ["other@example.com"], "password": PASSWORD }))
        .await;
    let now = orbitid_core::http::now();
    let switched = orbitid_core::ids::new_id(orbitid_core::ids::id_prefix::SESSION);
    sqlx::query(
        "INSERT INTO sessions (id, client_id, user_id, status, last_active_at, expire_at, \
         abandon_at, created_at, updated_at) VALUES ($1,$2,$3,'active',$4,$5,$5,$4,$4)",
    )
    .bind(&switched)
    .bind(&client_id)
    .bind(other["id"].as_str().unwrap())
    .bind(now)
    .bind(now + 3_600_000)
    .execute(&harness.state().pool)
    .await
    .unwrap();
    sqlx::query("UPDATE clients SET last_active_session_id = $1 WHERE id = $2")
        .bind(&switched)
        .bind(&client_id)
        .execute(&harness.state().pool)
        .await
        .unwrap();
    // The owner loses console access: its console row is revoked.
    harness
        .put(
            &format!("/v1/users/{owner_id}/roles"),
            json!({ "roles": [] }),
        )
        .await;

    let out = harness
        .client
        .delete(
            "/v1/operator_sessions/current?account=true",
            None,
            &[("cookie", &cookies)],
        )
        .await;
    assert_eq!(out.status, StatusCode::NO_CONTENT, "{}", out.text());
    for id in [&owner_session, &switched] {
        let status: String = sqlx::query_scalar("SELECT status FROM sessions WHERE id = $1")
            .bind(id)
            .fetch_one(&harness.state().pool)
            .await
            .unwrap();
        assert_ne!(status, "active", "{id}");
    }
}
