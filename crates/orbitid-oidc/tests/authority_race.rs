//! Organization-authority changes serialize with token issuance: the revoker
//! takes the user `FOR UPDATE` (rank 3), issuers key-share it, so no token row
//! of an in-flight exchange can escape the revocation, and claims planned
//! before a removal never reach a token.
//!
//! Deterministic sequencing through the exchange hooks, no sleeps.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;
use std::time::Duration;

use orbitid_core::AppState;
use orbitid_identity::testing::{
    add_test_member, create_test_client_session, create_test_organization, create_test_user,
    test_app_state_with,
};
use orbitid_oidc::services::oidc::applications::{
    create_application, ApplicationRow, CreateApplicationInput,
};
use orbitid_oidc::services::oidc::device::{
    create_device_authorization, decide_device_code, poll_device_code_with_hooks,
    DeviceAuthorizationInput, DeviceDecisionInput, DeviceTokenResult,
};
use orbitid_oidc::services::oidc::refresh::{
    exchange_refresh_token, RefreshExchangeHooks, RefreshExchangeOptions,
};
use orbitid_oidc::services::oidc::tokens::{
    exchange_authorization_code_with_hooks, issue_authorization_code, CodeExchangeInput,
    IssueCodeInput,
};
use tokio::sync::Notify;

const REDIRECT_URI: &str = "https://app.test/cb";

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
    panic!("the revoker never blocked");
}

struct Fixture {
    state: AppState,
    application: ApplicationRow,
    org_id: String,
    user_id: String,
    code: String,
}

async fn fixture(app: &orbitid_identity::testing::TestApp, tag: &str) -> Fixture {
    let state = app.state().clone();
    state
        .settings
        .update(serde_json::json!({ "organizations": { "enabled": true } }))
        .await
        .expect("enable organizations");
    let admin = create_test_user(&state, &format!("admin-{tag}@example.com"), "Sup3r-secret!")
        .await
        .expect("admin");
    let member = create_test_user(
        &state,
        &format!("member-{tag}@example.com"),
        "Sup3r-secret!",
    )
    .await
    .expect("member");
    let org = create_test_organization(&state, "Authority Org", None, &admin.user.id)
        .await
        .expect("org");
    add_test_member(&state, &org.id, &member.user.id, "org:member")
        .await
        .expect("member");
    let session = create_test_client_session(&state, &member.user.id)
        .await
        .expect("session");
    sqlx::query("UPDATE sessions SET last_active_organization_id = $2 WHERE id = $1")
        .bind(&session.session.id)
        .bind(&org.id)
        .execute(&state.pool)
        .await
        .expect("active organization");
    let application = create_application(
        &state,
        CreateApplicationInput {
            name: format!("Authority {tag}"),
            redirect_uris: Some(vec![REDIRECT_URI.into()]),
            scopes: Some("openid offline_access groups organizations".into()),
            groups_claim: Some("all".into()),
            ..Default::default()
        },
    )
    .await
    .expect("application")
    .0;
    let code = issue_authorization_code(
        &state,
        IssueCodeInput {
            application: &application,
            user_id: &member.user.id,
            scopes: &scopes(),
            redirect_uri: REDIRECT_URI,
            code_challenge: None,
            code_challenge_method: None,
            nonce: None,
            session_id: Some(&session.session.id),
        },
    )
    .await
    .expect("code");
    Fixture {
        state,
        application,
        org_id: org.id,
        user_id: member.user.id,
        code,
    }
}

fn scopes() -> Vec<String> {
    ["openid", "offline_access", "organizations"]
        .map(String::from)
        .to_vec()
}

async fn live_tokens(state: &AppState, user_id: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM oauth_grants \
         WHERE user_id = $1 AND kind IN ('access', 'refresh') AND revoked = false",
    )
    .bind(user_id)
    .fetch_one(&state.pool)
    .await
    .expect("count")
}

/// Pauses the exchange after it claimed the code row (uncommitted token rows).
struct PauseAfterConsume {
    paused: Notify,
    release: Notify,
}

#[async_trait::async_trait]
impl RefreshExchangeHooks for PauseAfterConsume {
    async fn after_consume(&self) {
        self.paused.notify_one();
        self.release.notified().await;
    }
}

/// Removes the member after the claims were planned, before the transaction.
struct LeaveBeforeTransaction {
    state: AppState,
    org_id: String,
    user_id: String,
}

#[async_trait::async_trait]
impl RefreshExchangeHooks for LeaveBeforeTransaction {
    async fn before_consume(&self) {
        orbitid_identity::orgs::leave_organization(&self.state, &self.org_id, &self.user_id)
            .await
            .expect("leave");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn removal_during_an_in_flight_exchange_leaves_no_live_token() {
    let app = test_app_state_with(orbitid_core::testing::test_pool_exemption(8)).await;
    let f = fixture(&app, "inflight").await;
    let hooks = Arc::new(PauseAfterConsume {
        paused: Notify::new(),
        release: Notify::new(),
    });
    let exchange = {
        let state = f.state.clone();
        let application = f.application.clone();
        let code = f.code.clone();
        let hooks = hooks.clone();
        tokio::spawn(async move {
            exchange_authorization_code_with_hooks(
                &state,
                CodeExchangeInput {
                    application: &application,
                    code: &code,
                    redirect_uri: Some(REDIRECT_URI),
                    code_verifier: None,
                    issuer: None,
                },
                Some(hooks.as_ref()),
            )
            .await
        })
    };
    hooks.paused.notified().await;
    let removal = {
        let state = f.state.clone();
        let (org_id, user_id) = (f.org_id.clone(), f.user_id.clone());
        tokio::spawn(async move {
            orbitid_identity::orgs::leave_organization(&state, &org_id, &user_id).await
        })
    };
    wait_for_lock_waiter(&f.state).await;
    hooks.release.notify_one();
    // The exchange may succeed or be refused; either way the removal leaves
    // no unrevoked token behind.
    exchange.await.expect("join").ok();
    removal.await.expect("join").expect("leave");
    assert_eq!(live_tokens(&f.state, &f.user_id).await, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn claims_planned_before_a_removal_are_not_issued() {
    let app = test_app_state_with(orbitid_core::testing::test_pool_exemption(8)).await;
    let f = fixture(&app, "stale").await;
    let hooks = LeaveBeforeTransaction {
        state: f.state.clone(),
        org_id: f.org_id.clone(),
        user_id: f.user_id.clone(),
    };
    let result = exchange_authorization_code_with_hooks(
        &f.state,
        CodeExchangeInput {
            application: &f.application,
            code: &f.code,
            redirect_uri: Some(REDIRECT_URI),
            code_verifier: None,
            issuer: None,
        },
        Some(&hooks),
    )
    .await;
    let error = result.expect_err("stale authority must be refused");
    assert_eq!(error.error, "invalid_grant");
    assert_eq!(live_tokens(&f.state, &f.user_id).await, 0);
}

/// What a hook does to the member's organization authority.
#[derive(Clone, Copy)]
enum Step {
    Nothing,
    Promote,
    Demote,
    /// Adds the member to `other_org`.
    Join,
    /// Removes the member from `other_org` again.
    Leave,
    /// Removes the member from the fixture organization.
    LeaveMain,
}

/// Runs one [`Step`] after the authority snapshot (before the claims are
/// planned) and one after planning (before the issuing transaction).
struct Churn {
    state: AppState,
    org_id: String,
    other_org: String,
    user_id: String,
    after_snapshot: Step,
    before_consume: Step,
}

impl Churn {
    async fn run(&self, step: Step) {
        match step {
            Step::Nothing => {}
            Step::Promote | Step::Demote => {
                let role = if matches!(step, Step::Promote) {
                    "org:admin"
                } else {
                    "org:member"
                };
                sqlx::query(
                    "UPDATE organization_memberships SET role_key = $3 \
                     WHERE organization_id = $1 AND user_id = $2",
                )
                .bind(&self.org_id)
                .bind(&self.user_id)
                .bind(role)
                .execute(&self.state.pool)
                .await
                .expect("role change");
            }
            Step::Join => {
                add_test_member(&self.state, &self.other_org, &self.user_id, "org:member")
                    .await
                    .expect("join")
            }
            Step::Leave => {
                orbitid_identity::orgs::leave_organization(
                    &self.state,
                    &self.other_org,
                    &self.user_id,
                )
                .await
                .expect("leave");
            }
            Step::LeaveMain => {
                orbitid_identity::orgs::leave_organization(
                    &self.state,
                    &self.org_id,
                    &self.user_id,
                )
                .await
                .expect("leave");
            }
        }
    }
}

#[async_trait::async_trait]
impl RefreshExchangeHooks for Churn {
    async fn after_authority_snapshot(&self) {
        self.run(self.after_snapshot).await;
    }
    async fn before_consume(&self) {
        self.run(self.before_consume).await;
    }
}

fn new_tag() -> String {
    orbitid_core::crypto::random_token(6).to_lowercase()
}

async fn churn(f: &Fixture, after_snapshot: Step, before_consume: Step) -> Churn {
    let admin = create_test_user(
        &f.state,
        &format!("owner-{}@example.com", new_tag()),
        "Sup3r-secret!",
    )
    .await
    .expect("other owner");
    let other = create_test_organization(
        &f.state,
        &format!("Other {}", new_tag()),
        None,
        &admin.user.id,
    )
    .await
    .expect("other org");
    Churn {
        state: f.state.clone(),
        org_id: f.org_id.clone(),
        other_org: other.id,
        user_id: f.user_id.clone(),
        after_snapshot,
        before_consume,
    }
}

fn jwt_claims(token: &str) -> serde_json::Value {
    use base64::Engine;
    let payload = token.split('.').nth(1).expect("jwt payload");
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .expect("base64");
    serde_json::from_slice(&bytes).expect("json")
}

async fn exchange_code(
    f: &Fixture,
    hooks: &Churn,
) -> Result<
    orbitid_oidc::services::oidc::token_set::TokenSet,
    orbitid_oidc::services::oidc::OAuthError,
> {
    exchange_authorization_code_with_hooks(
        &f.state,
        CodeExchangeInput {
            application: &f.application,
            code: &f.code,
            redirect_uri: Some(REDIRECT_URI),
            code_verifier: None,
            issuer: None,
        },
        Some(hooks),
    )
    .await
}

fn organization_ids(claims: &serde_json::Value) -> Vec<String> {
    claims["organizations"]
        .as_array()
        .expect("organizations claim")
        .iter()
        .map(|org| org["id"].as_str().expect("id").to_string())
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn promote_then_demote_between_snapshot_and_compare_never_reaches_a_token() {
    let app = test_app_state_with(orbitid_core::testing::test_pool_exemption(8)).await;
    let f = fixture(&app, "aba-role").await;
    // Promoted before the claims are planned, demoted again before the compare:
    // the compare sees the original authority, so only the snapshot may supply
    // the claims.
    let hooks = churn(&f, Step::Promote, Step::Demote).await;
    let result = exchange_code(&f, &hooks).await;
    if let Ok(tokens) = result {
        let claims = jwt_claims(&tokens.id_token.expect("id token"));
        assert_eq!(claims["org_role"], "org:member");
        let permissions = claims["org_permissions"].to_string();
        assert!(
            !permissions.contains("org:sys_memberships:manage"),
            "admin permissions leaked: {permissions}"
        );
        let role = claims["organizations"][0]["role"].as_str().expect("role");
        assert_eq!(role, "org:member");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn add_then_remove_between_snapshot_and_compare_leaves_no_claim() {
    let app = test_app_state_with(orbitid_core::testing::test_pool_exemption(8)).await;
    let f = fixture(&app, "aba-add").await;
    let hooks = churn(&f, Step::Join, Step::Leave).await;
    // The removal revokes the user's authority grants (the code row included),
    // so the exchange is either refused or carries only the snapshot's claims.
    match exchange_code(&f, &hooks).await {
        Ok(tokens) => {
            let claims = jwt_claims(&tokens.id_token.expect("id token"));
            assert_eq!(organization_ids(&claims), vec![f.org_id.clone()]);
        }
        Err(error) => assert_eq!(error.error, "invalid_grant"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn refresh_rotation_refuses_authority_that_changed_after_planning() {
    let app = test_app_state_with(orbitid_core::testing::test_pool_exemption(8)).await;
    let f = fixture(&app, "refresh").await;
    let first = exchange_code(&f, &churn(&f, Step::Nothing, Step::Nothing).await)
        .await
        .expect("first exchange");
    let refresh_token = first.refresh_token.expect("refresh token");
    let hooks = churn(&f, Step::Nothing, Step::LeaveMain).await;
    let error = exchange_refresh_token(
        &f.state,
        &f.application,
        &refresh_token,
        RefreshExchangeOptions {
            hooks: Some(&hooks),
            ..Default::default()
        },
    )
    .await
    .expect_err("stale authority must be refused");
    assert_eq!(error.error, "invalid_grant");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn device_poll_refuses_authority_that_changed_after_planning() {
    let app = test_app_state_with(orbitid_core::testing::test_pool_exemption(8)).await;
    let f = fixture(&app, "device").await;
    let authorization = create_device_authorization(
        &f.state,
        DeviceAuthorizationInput {
            application: &f.application,
            scopes: &scopes(),
        },
    )
    .await
    .expect("device authorization");
    decide_device_code(
        &f.state,
        DeviceDecisionInput {
            user_code: &authorization.row.user_code,
            user_id: &f.user_id,
            approve: true,
        },
    )
    .await
    .expect("approve");
    sqlx::query("UPDATE device_codes SET last_polled_at = NULL")
        .execute(&f.state.pool)
        .await
        .expect("reset poll");
    let hooks = churn(&f, Step::Nothing, Step::LeaveMain).await;
    let result = poll_device_code_with_hooks(
        &f.state,
        &f.application,
        &authorization.device_code,
        None,
        Some(&hooks),
    )
    .await
    .expect("poll");
    match result {
        DeviceTokenResult::Pending { error, .. } => assert_eq!(error, "authorization_pending"),
        DeviceTokenResult::Ok { .. } => panic!("stale authority was issued"),
    }
    assert_eq!(live_tokens(&f.state, &f.user_id).await, 0);
}
