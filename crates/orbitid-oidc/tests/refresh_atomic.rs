//! Ported from `test/core/oidc-refresh-rotation-atomic.test.ts`: consuming a
//! refresh token, checking the family and inserting its successor are one
//! serialized unit.

mod common;

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use orbitid_oidc::services::oidc::applications::{create_application, CreateApplicationInput};
use orbitid_oidc::services::oidc::refresh::{
    exchange_refresh_token, RefreshExchangeHooks, RefreshExchangeOptions,
};
use orbitid_oidc::services::oidc::tokens::{
    exchange_authorization_code, issue_authorization_code, CodeExchangeInput, IssueCodeInput,
};
use tokio::sync::{mpsc, oneshot, Mutex};

use common::{harness, insert_user, REDIRECT_URI};

struct GateHooks {
    reached: mpsc::Sender<()>,
    release: Mutex<Option<oneshot::Receiver<()>>>,
}

#[async_trait]
impl RefreshExchangeHooks for GateHooks {
    async fn after_consume(&self) {
        let _ = self.reached.send(()).await;
        let receiver = self.release.lock().await.take();
        if let Some(receiver) = receiver {
            let _ = receiver.await;
        }
    }
}

struct RevokeHooks {
    state: orbitid_core::AppState,
    session_id: String,
}

#[async_trait]
impl RefreshExchangeHooks for RevokeHooks {
    async fn before_consume(&self) {
        // The browser session ended after this rotation prepared its token set
        // but before it consumed the predecessor.
        orbitid_identity::grants::revoke_grants_for_session(&self.state, &self.session_id)
            .await
            .expect("revoke session grants");
    }
}

#[tokio::test]
async fn concurrent_duplicate_blocks_and_reuses_the_winners_successor() {
    let h = harness().await;
    let browser = insert_user(&h, "rotation@example.com").await;
    let (application, _) = create_application(
        h.state(),
        CreateApplicationInput {
            name: "Rotation".into(),
            redirect_uris: Some(vec![REDIRECT_URI.into()]),
            scopes: Some("openid profile offline_access".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let code = issue_authorization_code(
        h.state(),
        IssueCodeInput {
            application: &application,
            user_id: &browser.user.id,
            scopes: &["openid".into(), "offline_access".into()],
            redirect_uri: REDIRECT_URI,
            code_challenge: None,
            code_challenge_method: None,
            nonce: None,
            session_id: Some(&browser.session_id),
        },
    )
    .await
    .unwrap();
    let first = exchange_authorization_code(
        h.state(),
        CodeExchangeInput {
            application: &application,
            code: &code,
            redirect_uri: Some(REDIRECT_URI),
            code_verifier: None,
            issuer: None,
        },
    )
    .await
    .unwrap();
    let original = first.refresh_token.expect("refresh token");

    let (reached_tx, mut reached_rx) = mpsc::channel(1);
    let (release_tx, release_rx) = oneshot::channel();
    let hooks = Arc::new(GateHooks {
        reached: reached_tx,
        release: Mutex::new(Some(release_rx)),
    });

    let state_a = h.state().clone();
    let app_a = application.clone();
    let token_a = original.clone();
    let hooks_a = hooks.clone();
    let winner = tokio::spawn(async move {
        let hooks_ref: &dyn RefreshExchangeHooks = &*hooks_a;
        exchange_refresh_token(
            &state_a,
            &app_a,
            &token_a,
            RefreshExchangeOptions {
                issuer: None,
                scopes: None,
                hooks: Some(hooks_ref),
            },
        )
        .await
    });
    reached_rx.recv().await.expect("winner reached the gap");

    let state_b = h.state().clone();
    let app_b = application.clone();
    let token_b = original.clone();
    let mut loser = tokio::spawn(async move {
        exchange_refresh_token(
            &state_b,
            &app_b,
            &token_b,
            RefreshExchangeOptions::default(),
        )
        .await
    });
    // The duplicate must block on the family lock rather than race ahead.
    assert!(
        tokio::time::timeout(Duration::from_millis(200), &mut loser)
            .await
            .is_err(),
        "the duplicate did not block"
    );
    release_tx.send(()).expect("release the winner");

    let winner = winner.await.unwrap().unwrap();
    let loser = loser.await.unwrap().unwrap();
    assert_eq!(loser.refresh_token, winner.refresh_token);

    let rows = sqlx::query_as::<_, orbitid_core::models::OauthGrantRow>(
        "SELECT * FROM oauth_grants WHERE application_id = $1",
    )
    .bind(&application.id)
    .fetch_all(&h.state().pool)
    .await
    .unwrap();
    let refreshes: Vec<_> = rows.iter().filter(|row| row.kind == "refresh").collect();
    assert_eq!(refreshes.len(), 2);
    let consumed = refreshes
        .iter()
        .find(|row| row.revoked)
        .expect("a consumed predecessor");
    assert!(consumed.consumed_at.is_some());
    let successor = refreshes
        .iter()
        .find(|row| !row.revoked)
        .expect("a live successor");
    assert_eq!(
        consumed.successor_id.as_deref(),
        Some(successor.id.as_str())
    );
    assert!(rows
        .iter()
        .filter(|row| row.kind == "access")
        .all(|row| !row.revoked));
}

#[tokio::test]
async fn a_family_revoked_during_rotation_gets_no_successor() {
    let h = harness().await;
    let browser = insert_user(&h, "revoked-family@example.com").await;
    let (application, _) = create_application(
        h.state(),
        CreateApplicationInput {
            name: "Revoked family".into(),
            redirect_uris: Some(vec![REDIRECT_URI.into()]),
            scopes: Some("openid offline_access".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let code = issue_authorization_code(
        h.state(),
        IssueCodeInput {
            application: &application,
            user_id: &browser.user.id,
            scopes: &["openid".into(), "offline_access".into()],
            redirect_uri: REDIRECT_URI,
            code_challenge: None,
            code_challenge_method: None,
            nonce: None,
            session_id: Some(&browser.session_id),
        },
    )
    .await
    .unwrap();
    let first = exchange_authorization_code(
        h.state(),
        CodeExchangeInput {
            application: &application,
            code: &code,
            redirect_uri: Some(REDIRECT_URI),
            code_verifier: None,
            issuer: None,
        },
    )
    .await
    .unwrap();
    let original = first.refresh_token.expect("refresh token");
    let hooks = RevokeHooks {
        state: h.state().clone(),
        session_id: browser.session_id.clone(),
    };
    let result = exchange_refresh_token(
        h.state(),
        &application,
        &original,
        RefreshExchangeOptions {
            issuer: None,
            scopes: None,
            hooks: Some(&hooks),
        },
    )
    .await;
    let error = result.expect_err("rotation into a revoked family must fail");
    assert_eq!(error.error, "invalid_grant");

    let rows = sqlx::query_as::<_, orbitid_core::models::OauthGrantRow>(
        "SELECT * FROM oauth_grants WHERE application_id = $1",
    )
    .bind(&application.id)
    .fetch_all(&h.state().pool)
    .await
    .unwrap();
    assert!(rows.iter().all(|row| row.revoked));
    assert!(rows
        .iter()
        .filter(|row| row.kind == "refresh")
        .all(|row| row.revoked));
    assert_eq!(
        rows.iter().filter(|row| row.kind == "refresh").count(),
        1,
        "no successor was inserted"
    );
}
