//! A ban that commits between a request's unlocked eligibility read and the
//! lock its credential-issuing transaction takes must stop the issuance.
//!
//! Deterministic sequencing, no sleeps: a held transaction takes the user row
//! `FOR UPDATE` and sets `banned = true` (a ban *without* its grant revocation,
//! so the re-check is the only thing that can stop the request). The request
//! under test passes its unlocked pre-check, blocks on the user's key-share, and
//! only then does the ban commit.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::future::Future;
use std::time::Duration;

use orbitid_core::AppState;
use orbitid_identity::testing::{
    create_test_client_session, create_test_user, test_app_state_with, TestApp,
};
use orbitid_oidc::services::oidc::applications::{create_application, CreateApplicationInput};
use orbitid_oidc::services::oidc::device::{
    create_device_authorization, decide_device_code, poll_device_code, DeviceAuthorizationInput,
    DeviceDecisionInput, DeviceTokenResult,
};
use orbitid_oidc::services::oidc::refresh::{
    exchange_refresh_token, RefreshExchangeHooks, RefreshExchangeOptions,
};
use orbitid_oidc::services::oidc::tokens::{
    exchange_authorization_code, issue_authorization_code, CodeExchangeInput, IssueCodeInput,
};

const REDIRECT_URI: &str = "https://app.test/cb";

async fn app() -> TestApp {
    test_app_state_with(orbitid_core::testing::test_pool_exemption(6)).await
}

async fn wait_for_lock_waiter(state: &AppState) {
    for _ in 0..400 {
        let waiting: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pg_stat_activity \
             WHERE datname = current_database() AND wait_event_type = 'Lock'",
        )
        .fetch_one(&state.pool)
        .await
        .expect("activity");
        if waiting > 0 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("the request never blocked on the user row");
}

/// Holds an uncommitted ban, starts `request`, waits until it blocks on the
/// user row, commits the ban and returns the request's result.
async fn ban_while_blocked<T, F>(state: &AppState, user_id: &str, request: F) -> T
where
    T: Send + 'static,
    F: Future<Output = T> + Send + 'static,
{
    let mut ban = state.pool.begin().await.expect("begin");
    sqlx::query("SELECT id FROM users WHERE id = $1 FOR UPDATE")
        .bind(user_id)
        .execute(&mut *ban)
        .await
        .expect("lock user");
    sqlx::query("UPDATE users SET banned = true WHERE id = $1")
        .bind(user_id)
        .execute(&mut *ban)
        .await
        .expect("ban");
    let handle = tokio::spawn(request);
    wait_for_lock_waiter(state).await;
    ban.commit().await.expect("commit ban");
    handle.await.expect("join")
}

async fn grant_count(state: &AppState, application_id: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM oauth_grants WHERE application_id = $1")
        .bind(application_id)
        .fetch_one(&state.pool)
        .await
        .expect("count")
}

async fn application(
    state: &AppState,
    name: &str,
) -> orbitid_oidc::services::oidc::applications::ApplicationRow {
    create_application(
        state,
        CreateApplicationInput {
            name: name.into(),
            redirect_uris: Some(vec![REDIRECT_URI.into()]),
            scopes: Some("openid offline_access".into()),
            ..Default::default()
        },
    )
    .await
    .expect("application")
    .0
}

fn scopes() -> Vec<String> {
    vec!["openid".into(), "offline_access".into()]
}

async fn code_for(
    state: &AppState,
    application: &orbitid_oidc::services::oidc::applications::ApplicationRow,
    user_id: &str,
) -> String {
    issue_authorization_code(
        state,
        IssueCodeInput {
            application,
            user_id,
            scopes: &scopes(),
            redirect_uri: REDIRECT_URI,
            code_challenge: None,
            code_challenge_method: None,
            nonce: None,
            session_id: None,
        },
    )
    .await
    .expect("code")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn code_exchange_refuses_a_user_banned_after_the_precheck() {
    let app = app().await;
    let state = app.state().clone();
    let user = create_test_user(&state, "race-code@example.com", "Sup3r-secret!")
        .await
        .expect("user");
    let application = application(&state, "Race code").await;
    let code = code_for(&state, &application, &user.user.id).await;
    let before = grant_count(&state, &application.id).await;
    let result = {
        let state = state.clone();
        let application = application.clone();
        ban_while_blocked(&state.clone(), &user.user.id, async move {
            exchange_authorization_code(
                &state,
                CodeExchangeInput {
                    application: &application,
                    code: &code,
                    redirect_uri: Some(REDIRECT_URI),
                    code_verifier: None,
                    issuer: None,
                },
            )
            .await
            .map(|_| ())
            .map_err(|error| error.error)
        })
        .await
    };
    assert_eq!(result, Err("invalid_grant".to_string()));
    assert_eq!(
        grant_count(&state, &application.id).await,
        before,
        "no token rows"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn device_poll_refuses_a_user_banned_after_the_precheck() {
    let app = app().await;
    let state = app.state().clone();
    let user = create_test_user(&state, "race-device@example.com", "Sup3r-secret!")
        .await
        .expect("user");
    let application = application(&state, "Race device").await;
    let authorization = create_device_authorization(
        &state,
        DeviceAuthorizationInput {
            application: &application,
            scopes: &scopes(),
        },
    )
    .await
    .expect("device authorization");
    decide_device_code(
        &state,
        DeviceDecisionInput {
            user_code: &authorization.row.user_code,
            user_id: &user.user.id,
            approve: true,
        },
    )
    .await
    .expect("approve");
    // The poll interval gate: make the last poll old enough.
    sqlx::query("UPDATE device_codes SET last_polled_at = NULL")
        .execute(&state.pool)
        .await
        .expect("reset poll");
    let result = {
        let state = state.clone();
        let application = application.clone();
        let device_code = authorization.device_code.clone();
        ban_while_blocked(&state.clone(), &user.user.id, async move {
            poll_device_code(&state, &application, &device_code, None).await
        })
        .await
    };
    match result.expect("poll") {
        DeviceTokenResult::Pending { error, .. } => assert_eq!(error, "access_denied"),
        DeviceTokenResult::Ok { .. } => panic!("a banned user received device tokens"),
    }
    assert_eq!(grant_count(&state, &application.id).await, 0);
}

struct BanBeforeConsume {
    state: AppState,
    user_id: String,
}

#[async_trait::async_trait]
impl RefreshExchangeHooks for BanBeforeConsume {
    async fn before_consume(&self) {
        sqlx::query("UPDATE users SET banned = true WHERE id = $1")
            .bind(&self.user_id)
            .execute(&self.state.pool)
            .await
            .expect("ban");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn refresh_rotation_refuses_a_user_banned_after_the_precheck() {
    let app = app().await;
    let state = app.state().clone();
    let user = create_test_user(&state, "race-refresh@example.com", "Sup3r-secret!")
        .await
        .expect("user");
    let application = application(&state, "Race refresh").await;
    let code = code_for(&state, &application, &user.user.id).await;
    let first = exchange_authorization_code(
        &state,
        CodeExchangeInput {
            application: &application,
            code: &code,
            redirect_uri: Some(REDIRECT_URI),
            code_verifier: None,
            issuer: None,
        },
    )
    .await
    .expect("exchange");
    let refresh = first.refresh_token.expect("refresh token");
    let before = grant_count(&state, &application.id).await;
    let hooks = BanBeforeConsume {
        state: state.clone(),
        user_id: user.user.id.clone(),
    };
    let error = exchange_refresh_token(
        &state,
        &application,
        &refresh,
        RefreshExchangeOptions {
            issuer: None,
            scopes: None,
            hooks: Some(&hooks),
        },
    )
    .await
    .expect_err("a banned user must not rotate");
    assert_eq!(error.error, "invalid_grant");
    assert_eq!(
        grant_count(&state, &application.id).await,
        before,
        "no successor tokens"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn consent_and_device_approval_refuse_a_user_banned_after_authentication() {
    let app = app().await;
    let state = app.state().clone();
    let user = create_test_user(&state, "race-consent@example.com", "Sup3r-secret!")
        .await
        .expect("user");
    let application = application(&state, "Race consent").await;
    let consent = {
        let state = state.clone();
        let application_id = application.id.clone();
        let user_id = user.user.id.clone();
        ban_while_blocked(&state.clone(), &user.user.id, async move {
            let mut tx = state.pool.begin().await.expect("begin");
            orbitid_oidc::services::oidc::consent::record_consent_on(
                &mut tx,
                &application_id,
                &user_id,
                &scopes(),
            )
            .await
            .map_err(|error| error.code)
        })
        .await
    };
    assert_eq!(consent, Err("user_banned".to_string()));
    let consents: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM oauth_consents")
        .fetch_one(&state.pool)
        .await
        .expect("consents");
    assert_eq!(consents, 0);

    // Device approval by another not-yet-banned user, banned during approval.
    let other = create_test_user(&state, "race-approve@example.com", "Sup3r-secret!")
        .await
        .expect("other");
    let authorization = create_device_authorization(
        &state,
        DeviceAuthorizationInput {
            application: &application,
            scopes: &scopes(),
        },
    )
    .await
    .expect("device authorization");
    let approval = {
        let state = state.clone();
        let user_code = authorization.row.user_code.clone();
        let user_id = other.user.id.clone();
        ban_while_blocked(&state.clone(), &other.user.id, async move {
            decide_device_code(
                &state,
                DeviceDecisionInput {
                    user_code: &user_code,
                    user_id: &user_id,
                    approve: true,
                },
            )
            .await
            .map(|_| ())
            .map_err(|error| error.code)
        })
        .await
    };
    assert_eq!(approval, Err("user_banned".to_string()));
    let status: String = sqlx::query_scalar("SELECT status FROM device_codes LIMIT 1")
        .fetch_one(&state.pool)
        .await
        .expect("status");
    assert_eq!(status, "pending");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn api_keys_sessions_and_session_tokens_refuse_a_user_banned_after_the_precheck() {
    use orbitid_identity::sessions::{create_session, CreateSessionInput};
    use orbitid_oidc::services::api_keys::{create_api_key, CreateApiKeyInput};

    let app = app().await;
    let state = app.state().clone();
    let user = create_test_user(&state, "race-key@example.com", "Sup3r-secret!")
        .await
        .expect("user");
    let keys = {
        let state = state.clone();
        let subject = user.user.id.clone();
        ban_while_blocked(&state.clone(), &user.user.id, async move {
            create_api_key(
                &state,
                CreateApiKeyInput {
                    name: "k".into(),
                    subject,
                    ..Default::default()
                },
            )
            .await
            .map(|_| ())
            .map_err(|error| error.code)
        })
        .await
    };
    assert_eq!(keys, Err("user_banned".to_string()));
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM api_keys")
        .fetch_one(&state.pool)
        .await
        .expect("keys");
    assert_eq!(rows, 0);

    // Session creation (sign-in completion path) on a second user.
    let second = create_test_user(&state, "race-session@example.com", "Sup3r-secret!")
        .await
        .expect("second");
    let (client, _) = orbitid_identity::client_auth::create_client(&state, None, None)
        .await
        .expect("client");
    let session = {
        let state = state.clone();
        let user_id = second.user.id.clone();
        ban_while_blocked(&state.clone(), &second.user.id, async move {
            create_session(&state, CreateSessionInput::new(client.id.clone(), user_id))
                .await
                .map(|_| ())
                .map_err(|error| error.code)
        })
        .await
    };
    assert_eq!(session, Err("user_banned".to_string()));
    let sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE user_id = $1")
        .bind(&second.user.id)
        .fetch_one(&state.pool)
        .await
        .expect("sessions");
    assert_eq!(sessions, 0);

    // Session JWT: the session exists, the ban commits while the token is signed.
    let third = create_test_user(&state, "race-jwt@example.com", "Sup3r-secret!")
        .await
        .expect("third");
    let live = create_test_client_session(&state, &third.user.id)
        .await
        .expect("session");
    let token = {
        let state = state.clone();
        let session_id = live.session.id.clone();
        ban_while_blocked(&state.clone(), &third.user.id, async move {
            orbitid_identity::tokens::sign_session_token(&state, &session_id, Default::default())
                .await
                .map_err(|error| error.code)
        })
        .await
    };
    assert_eq!(token, Err("user_banned".to_string()));
}
