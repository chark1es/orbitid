//! Changes that narrow access to an organization-owned application serialize
//! with token issuance. An issuer holds the user key-share and the application
//! `FOR SHARE` from its access check until it commits; an owner change waits on
//! the application row, a grant revocation or membership removal on the user
//! row, and each revokes after the issuer committed. So no token minted by an
//! in-flight exchange or refresh outlives the change.
//!
//! Deterministic sequencing through the exchange hooks (as in
//! `authority_race.rs`), no sleeps beyond waiting for the blocked lock.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;
use std::time::Duration;

use orbitid_core::AppState;
use orbitid_identity::testing::{
    add_test_member, create_test_client_session, create_test_organization, create_test_user,
    test_app_state_with, TestApp,
};
use orbitid_oidc::services::oidc::access_grants::{
    grant_application_access, revoke_application_access,
};
use orbitid_oidc::services::oidc::applications::{
    create_application, update_application_with_effects, ApplicationRow, CreateApplicationInput,
    UpdateApplicationInput,
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
    panic!("the change never blocked on the issuer");
}

/// Pauses the issuer after it claimed the code / refresh row: its access check
/// passed and its token rows are inserted next, uncommitted.
struct PauseAfterConsume {
    paused: Notify,
    release: Notify,
}

impl PauseAfterConsume {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            paused: Notify::new(),
            release: Notify::new(),
        })
    }
}

#[async_trait::async_trait]
impl RefreshExchangeHooks for PauseAfterConsume {
    async fn after_consume(&self) {
        self.paused.notify_one();
        self.release.notified().await;
    }
}

struct Fixture {
    state: AppState,
    application: ApplicationRow,
    org_id: String,
    other_org_id: String,
    user_id: String,
    session_id: String,
}

/// `user` is a member of `org` (unless `member` is false); `other_org` is an
/// organization the user does not belong to. The application is owned by
/// `owner` (`None`: instance-wide, `Some(true)`: `org`, `Some(false)`:
/// `other_org`).
async fn fixture(app: &TestApp, tag: &str, member: bool, owner: Option<bool>) -> Fixture {
    let state = app.state().clone();
    let admin = create_test_user(&state, &format!("admin-{tag}@example.com"), "Sup3r-secret!")
        .await
        .expect("admin");
    let user = create_test_user(&state, &format!("user-{tag}@example.com"), "Sup3r-secret!")
        .await
        .expect("user");
    let org = create_test_organization(&state, &format!("Org {tag}"), None, &admin.user.id)
        .await
        .expect("org");
    let other = create_test_organization(&state, &format!("Other {tag}"), None, &admin.user.id)
        .await
        .expect("other org");
    if member {
        add_test_member(&state, &org.id, &user.user.id, "org:member")
            .await
            .expect("member");
    }
    let session = create_test_client_session(&state, &user.user.id)
        .await
        .expect("session");
    let application = create_application(
        &state,
        CreateApplicationInput {
            name: format!("Race {tag}"),
            redirect_uris: Some(vec![REDIRECT_URI.into()]),
            scopes: Some("openid offline_access".into()),
            organization_id: owner.map(|main| {
                if main {
                    org.id.clone()
                } else {
                    other.id.clone()
                }
            }),
            ..Default::default()
        },
    )
    .await
    .expect("application")
    .0;
    Fixture {
        state,
        application,
        org_id: org.id,
        other_org_id: other.id,
        user_id: user.user.id,
        session_id: session.session.id,
    }
}

fn scopes() -> Vec<String> {
    ["openid", "offline_access"].map(String::from).to_vec()
}

async fn code_for(f: &Fixture) -> String {
    issue_authorization_code(
        &f.state,
        IssueCodeInput {
            application: &f.application,
            user_id: &f.user_id,
            scopes: &scopes(),
            redirect_uri: REDIRECT_URI,
            code_challenge: None,
            code_challenge_method: None,
            nonce: None,
            session_id: Some(&f.session_id),
        },
    )
    .await
    .expect("code")
}

/// A refresh token for the fixture user, through an unhooked code exchange.
async fn refresh_token_for(f: &Fixture) -> String {
    let code = code_for(f).await;
    exchange_authorization_code_with_hooks(
        &f.state,
        CodeExchangeInput {
            application: &f.application,
            code: &code,
            redirect_uri: Some(REDIRECT_URI),
            code_verifier: None,
            issuer: None,
        },
        None,
    )
    .await
    .expect("exchange")
    .refresh_token
    .expect("refresh token")
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

/// Spawns a refresh that pauses inside its issuing transaction.
fn paused_refresh(
    f: &Fixture,
    refresh_token: String,
    hooks: Arc<PauseAfterConsume>,
) -> tokio::task::JoinHandle<bool> {
    let state = f.state.clone();
    let application = f.application.clone();
    tokio::spawn(async move {
        exchange_refresh_token(
            &state,
            &application,
            &refresh_token,
            RefreshExchangeOptions {
                hooks: Some(hooks.as_ref()),
                ..Default::default()
            },
        )
        .await
        .is_ok()
    })
}

/// Moves the application to the organization the user does not belong to.
fn spawn_owner_change(f: &Fixture) -> tokio::task::JoinHandle<orbitid_core::Result<()>> {
    let state = f.state.clone();
    let application = f.application.clone();
    let owner = f.other_org_id.clone();
    tokio::spawn(async move {
        update_application_with_effects(
            &state,
            &application,
            UpdateApplicationInput {
                organization_id: Some(Some(owner)),
                ..Default::default()
            },
        )
        .await
        .map(|_| ())
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_owner_change_during_an_in_flight_refresh_leaves_no_live_token() {
    let app = test_app_state_with(orbitid_core::testing::test_pool_exemption(8)).await;
    let f = fixture(&app, "owner-refresh", true, None).await;
    let refresh_token = refresh_token_for(&f).await;
    let hooks = PauseAfterConsume::new();
    let refresh = paused_refresh(&f, refresh_token, hooks.clone());
    hooks.paused.notified().await;

    let change = spawn_owner_change(&f);
    // The owner change waits on the application row the refresh holds.
    wait_for_lock_waiter(&f.state).await;
    hooks.release.notify_one();
    assert!(
        refresh.await.expect("join"),
        "the refresh began first and commits"
    );
    change.await.expect("join").expect("owner change");
    // ...and the owner change, committing after it, revoked what it minted.
    assert_eq!(live_tokens(&f.state, &f.user_id).await, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_owner_change_during_an_in_flight_code_exchange_leaves_no_live_token() {
    let app = test_app_state_with(orbitid_core::testing::test_pool_exemption(8)).await;
    let f = fixture(&app, "owner-code", true, None).await;
    let code = code_for(&f).await;
    let hooks = PauseAfterConsume::new();
    let exchange = {
        let state = f.state.clone();
        let application = f.application.clone();
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
            .is_ok()
        })
    };
    hooks.paused.notified().await;

    let change = spawn_owner_change(&f);
    wait_for_lock_waiter(&f.state).await;
    hooks.release.notify_one();
    assert!(exchange.await.expect("join"));
    change.await.expect("join").expect("owner change");
    assert_eq!(live_tokens(&f.state, &f.user_id).await, 0);
}

/// The owner changes after the refresh planned its tokens but before its
/// transaction: the in-transaction access check refuses it.
struct ChangeOwnerBeforeTransaction {
    state: AppState,
    application: ApplicationRow,
    owner: String,
}

#[async_trait::async_trait]
impl RefreshExchangeHooks for ChangeOwnerBeforeTransaction {
    async fn before_consume(&self) {
        update_application_with_effects(
            &self.state,
            &self.application,
            UpdateApplicationInput {
                organization_id: Some(Some(self.owner.clone())),
                ..Default::default()
            },
        )
        .await
        .expect("owner change");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_owner_change_before_the_refresh_transaction_refuses_it() {
    let app = test_app_state_with(orbitid_core::testing::test_pool_exemption(8)).await;
    let f = fixture(&app, "owner-before", true, None).await;
    let refresh_token = refresh_token_for(&f).await;
    let hooks = ChangeOwnerBeforeTransaction {
        state: f.state.clone(),
        application: f.application.clone(),
        owner: f.other_org_id.clone(),
    };
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
    .expect_err("the refresh reads the new owner under its locks");
    assert_eq!(error.error, "invalid_grant");
    assert_eq!(live_tokens(&f.state, &f.user_id).await, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_grant_revocation_during_an_in_flight_refresh_leaves_no_live_token() {
    let app = test_app_state_with(orbitid_core::testing::test_pool_exemption(8)).await;
    // Not a member: the access grant is the only way in.
    let f = fixture(&app, "grant-refresh", false, Some(true)).await;
    grant_application_access(&f.state, &f.application.id, &f.user_id)
        .await
        .expect("grant");
    let refresh_token = refresh_token_for(&f).await;
    let hooks = PauseAfterConsume::new();
    let refresh = paused_refresh(&f, refresh_token, hooks.clone());
    hooks.paused.notified().await;

    let revoke = {
        let state = f.state.clone();
        let (application_id, user_id) = (f.application.id.clone(), f.user_id.clone());
        tokio::spawn(async move {
            revoke_application_access(&state, &application_id, &user_id)
                .await
                .map(|revoked| revoked.is_some())
        })
    };
    // The revocation waits on the user row the refresh key-shares.
    wait_for_lock_waiter(&f.state).await;
    hooks.release.notify_one();
    assert!(refresh.await.expect("join"));
    assert!(revoke.await.expect("join").expect("revoke"));
    assert_eq!(live_tokens(&f.state, &f.user_id).await, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_membership_removal_during_an_in_flight_refresh_leaves_no_live_token() {
    let app = test_app_state_with(orbitid_core::testing::test_pool_exemption(8)).await;
    let f = fixture(&app, "member-refresh", true, Some(true)).await;
    let refresh_token = refresh_token_for(&f).await;
    let hooks = PauseAfterConsume::new();
    let refresh = paused_refresh(&f, refresh_token, hooks.clone());
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
    assert!(refresh.await.expect("join"));
    removal.await.expect("join").expect("leave");
    assert_eq!(live_tokens(&f.state, &f.user_id).await, 0);
}
