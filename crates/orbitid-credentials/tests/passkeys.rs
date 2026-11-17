//! Passkey ceremonies with the exported software authenticator.
//!
//! Run with `cargo test -p orbitid-credentials --features test-util`.

#![cfg(feature = "test-util")]

mod common;

use orbitid_core::testing::test_state;
use orbitid_credentials::{
    begin_passkey_authentication, begin_passkey_registration, finish_passkey_authentication,
    finish_passkey_registration, list_passkeys, relying_party, BeginAuthenticationInput,
    BeginRegistrationInput, CredentialOverrides, FinishAuthenticationInput,
    FinishRegistrationInput, VirtualAuthenticator, VirtualAuthenticatorOptions,
};

const APP_ORIGIN: &str = "http://localhost:3000";
const APP_RP_ID: &str = "localhost";

fn software_authenticator() -> VirtualAuthenticator {
    VirtualAuthenticator::new(VirtualAuthenticatorOptions::new(APP_RP_ID, APP_ORIGIN)).unwrap()
}

#[tokio::test]
async fn registers_and_signs_in_with_a_passkey() {
    let context = test_state().await;
    let state = &context.state;
    let user = common::insert_user(&state.pool, "user_ada", "ada@example.com").await;
    let rp = relying_party(state, Some(APP_ORIGIN)).unwrap();
    assert_eq!(rp.rp_id, APP_RP_ID);
    assert_eq!(rp.origin, APP_ORIGIN);

    let begin = begin_passkey_registration(
        state,
        BeginRegistrationInput {
            user_id: user.id.clone(),
            user_name: "ada@example.com".into(),
            display_name: "Ada Lovelace".into(),
            rp: rp.clone(),
            authenticator_type: Some("platform".into()),
            name: Some("Laptop".into()),
        },
    )
    .await
    .unwrap();
    assert_eq!(
        begin
            .options
            .authenticator_selection
            .authenticator_attachment
            .as_deref(),
        Some("platform")
    );
    assert!(list_passkeys(&state.pool, &user.id)
        .await
        .unwrap()
        .is_empty());

    let mut authenticator = software_authenticator();
    let credential = authenticator.register(&begin.options, CredentialOverrides::default());
    let passkey = finish_passkey_registration(
        state,
        FinishRegistrationInput {
            passkey_id: begin.passkey_id.clone(),
            user_id: user.id.clone(),
            credential,
            name: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(passkey.id, begin.passkey_id);
    assert_eq!(passkey.name, "Laptop");
    assert_eq!(passkey.credential_id, authenticator.credential_id);
    assert_eq!(passkey.counter, 0);
    assert_eq!(
        passkey.transports.map(|transports| transports.0),
        Some(vec!["internal".into(), "hybrid".into()])
    );
    assert_eq!(passkey.device_type.as_deref(), Some("multiDevice"));
    assert!(passkey.backed_up);
    assert!(!passkey.public_key.is_empty());
    assert_eq!(list_passkeys(&state.pool, &user.id).await.unwrap().len(), 1);

    let options = begin_passkey_authentication(
        state,
        BeginAuthenticationInput {
            rp: rp.clone(),
            user_id: Some(user.id.clone()),
            owner_id: "sia_test".into(),
            allow_credentials: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        options.allow_credentials.len(),
        1,
        "identifier-first limits credentials"
    );
    let assertion = authenticator.authenticate(&options, CredentialOverrides::default());
    let (signed_in, updated) = finish_passkey_authentication(
        state,
        FinishAuthenticationInput {
            owner_id: "sia_test".into(),
            credential: assertion,
        },
    )
    .await
    .unwrap();
    assert_eq!(signed_in.id, user.id);
    assert_eq!(updated.counter, 1);
    assert!(updated.last_used_at.is_some());
}

#[tokio::test]
async fn discoverable_authentication_lists_no_credentials() {
    let context = test_state().await;
    let state = &context.state;
    let user = common::insert_user(&state.pool, "user_ada", "ada@example.com").await;
    let rp = relying_party(state, Some(APP_ORIGIN)).unwrap();
    let begin = begin_passkey_registration(
        state,
        BeginRegistrationInput {
            user_id: user.id.clone(),
            user_name: "ada".into(),
            display_name: "Ada".into(),
            rp: rp.clone(),
            authenticator_type: None,
            name: None,
        },
    )
    .await
    .unwrap();
    let mut authenticator = software_authenticator();
    let credential = authenticator.register(&begin.options, CredentialOverrides::default());
    finish_passkey_registration(
        state,
        FinishRegistrationInput {
            passkey_id: begin.passkey_id,
            user_id: user.id.clone(),
            credential,
            name: Some("Phone".into()),
        },
    )
    .await
    .unwrap();

    let options = begin_passkey_authentication(
        state,
        BeginAuthenticationInput {
            rp: rp.clone(),
            user_id: None,
            owner_id: "sia_discover".into(),
            allow_credentials: None,
        },
    )
    .await
    .unwrap();
    assert!(options.allow_credentials.is_empty());
    assert_eq!(options.rp_id, APP_RP_ID);
    let assertion = authenticator.authenticate(&options, CredentialOverrides::default());
    let (signed_in, updated) = finish_passkey_authentication(
        state,
        FinishAuthenticationInput {
            owner_id: "sia_discover".into(),
            credential: assertion,
        },
    )
    .await
    .unwrap();
    assert_eq!(signed_in.id, user.id);
    assert_eq!(updated.counter, 1);
}

#[tokio::test]
async fn rejects_wrong_challenge_origin_and_rp_id() {
    for overrides in [
        CredentialOverrides {
            challenge: Some("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into()),
            ..Default::default()
        },
        CredentialOverrides {
            origin: Some("https://evil.example".into()),
            ..Default::default()
        },
        CredentialOverrides {
            rp_id: Some("evil.example".into()),
            ..Default::default()
        },
        CredentialOverrides {
            user_verified: Some(false),
            ..Default::default()
        },
    ] {
        let context = test_state().await;
        let state = &context.state;
        let user = common::insert_user(&state.pool, "user_ada", "ada@example.com").await;
        let rp = relying_party(state, Some(APP_ORIGIN)).unwrap();
        let begin = begin_passkey_registration(
            state,
            BeginRegistrationInput {
                user_id: user.id.clone(),
                user_name: "ada".into(),
                display_name: "Ada".into(),
                rp,
                authenticator_type: None,
                name: None,
            },
        )
        .await
        .unwrap();
        let mut authenticator = software_authenticator();
        let credential = authenticator.register(&begin.options, overrides);
        let error = finish_passkey_registration(
            state,
            FinishRegistrationInput {
                passkey_id: begin.passkey_id,
                user_id: user.id.clone(),
                credential,
                name: None,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "passkey_registration_failure");
        assert!(list_passkeys(&state.pool, &user.id)
            .await
            .unwrap()
            .is_empty());
    }
}

#[tokio::test]
async fn challenge_can_only_be_spent_once_and_expires() {
    let context = test_state().await;
    let state = &context.state;
    let user = common::insert_user(&state.pool, "user_ada", "ada@example.com").await;
    let rp = relying_party(state, Some(APP_ORIGIN)).unwrap();
    let begin = begin_passkey_registration(
        state,
        BeginRegistrationInput {
            user_id: user.id.clone(),
            user_name: "ada".into(),
            display_name: "Ada".into(),
            rp: rp.clone(),
            authenticator_type: None,
            name: None,
        },
    )
    .await
    .unwrap();
    let mut authenticator = software_authenticator();
    let credential = authenticator.register(&begin.options, CredentialOverrides::default());
    finish_passkey_registration(
        state,
        FinishRegistrationInput {
            passkey_id: begin.passkey_id.clone(),
            user_id: user.id.clone(),
            credential: credential.clone(),
            name: None,
        },
    )
    .await
    .unwrap();
    let replay = finish_passkey_registration(
        state,
        FinishRegistrationInput {
            passkey_id: begin.passkey_id,
            user_id: user.id,
            credential,
            name: None,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(replay.code, "verification_expired");

    // An expired challenge is refused before any signature work.
    let user = common::insert_user(&state.pool, "user_bob", "bob@example.com").await;
    let begin = begin_passkey_registration(
        state,
        BeginRegistrationInput {
            user_id: user.id.clone(),
            user_name: "bob".into(),
            display_name: "Bob".into(),
            rp,
            authenticator_type: None,
            name: None,
        },
    )
    .await
    .unwrap();
    let credential = authenticator.register(&begin.options, CredentialOverrides::default());
    sqlx::query(
        "UPDATE verifications SET expires_at = $1 WHERE purpose = 'passkey_registration' AND owner_id = $2",
    )
    .bind(orbitid_core::http::now() - 1)
    .bind(&begin.passkey_id)
    .execute(&state.pool)
    .await
    .unwrap();
    let expired = finish_passkey_registration(
        state,
        FinishRegistrationInput {
            passkey_id: begin.passkey_id,
            user_id: user.id,
            credential,
            name: None,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(expired.code, "verification_expired");
}

#[tokio::test]
async fn refuses_counter_regressions_and_unknown_credentials() {
    let context = test_state().await;
    let state = &context.state;
    let user = common::insert_user(&state.pool, "user_ada", "ada@example.com").await;
    let rp = relying_party(state, Some(APP_ORIGIN)).unwrap();
    let begin = begin_passkey_registration(
        state,
        BeginRegistrationInput {
            user_id: user.id.clone(),
            user_name: "ada".into(),
            display_name: "Ada".into(),
            rp: rp.clone(),
            authenticator_type: None,
            name: None,
        },
    )
    .await
    .unwrap();
    let mut authenticator = software_authenticator();
    let credential = authenticator.register(&begin.options, CredentialOverrides::default());
    finish_passkey_registration(
        state,
        FinishRegistrationInput {
            passkey_id: begin.passkey_id,
            user_id: user.id.clone(),
            credential,
            name: None,
        },
    )
    .await
    .unwrap();

    let sign_in = |owner: &'static str| BeginAuthenticationInput {
        rp: rp.clone(),
        user_id: Some(user.id.clone()),
        owner_id: owner.into(),
        allow_credentials: None,
    };
    let options = begin_passkey_authentication(state, sign_in("sia_first"))
        .await
        .unwrap();
    let assertion = authenticator.authenticate(&options, CredentialOverrides::default());
    finish_passkey_authentication(
        state,
        FinishAuthenticationInput {
            owner_id: "sia_first".into(),
            credential: assertion,
        },
    )
    .await
    .unwrap();

    let options = begin_passkey_authentication(state, sign_in("sia_clone"))
        .await
        .unwrap();
    let assertion = authenticator.authenticate(
        &options,
        CredentialOverrides {
            counter: Some(1),
            ..Default::default()
        },
    );
    let error = finish_passkey_authentication(
        state,
        FinishAuthenticationInput {
            owner_id: "sia_clone".into(),
            credential: assertion,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "passkey_authentication_failure");

    let options = begin_passkey_authentication(state, sign_in("sia_unknown"))
        .await
        .unwrap();
    let mut stranger = software_authenticator();
    let assertion = stranger.authenticate(&options, CredentialOverrides::default());
    let error = finish_passkey_authentication(
        state,
        FinishAuthenticationInput {
            owner_id: "sia_unknown".into(),
            credential: assertion,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "passkey_authentication_failure");
}

#[tokio::test]
async fn add_and_delete_passkey_on_join_the_callers_transaction() {
    let context = test_state().await;
    let state = &context.state;
    let user = common::insert_user(&state.pool, "user_transaction", "tx@example.com").await;
    let input = orbitid_credentials::AddPasskeyInput {
        id: "pkey_transaction".into(),
        user_id: user.id.clone(),
        name: "Security key".into(),
        credential_id: "cred_transaction".into(),
        public_key: "cHVibGlj".into(),
        counter: 0,
        transports: Some(vec!["usb".into()]),
        device_type: Some("cross-platform".into()),
        backed_up: false,
    };
    let mut tx = state.pool.begin().await.unwrap();
    let added = orbitid_credentials::add_passkey_on(&mut tx, &input)
        .await
        .unwrap();
    let duplicate = orbitid_credentials::add_passkey_on(&mut tx, &input).await;
    assert!(
        duplicate.is_err(),
        "a duplicate credential id is a conflict"
    );
    tx.commit().await.unwrap();
    assert_eq!(added.user_id, user.id);
    assert_eq!(list_passkeys(&state.pool, &user.id).await.unwrap().len(), 1);

    let mut tx = state.pool.begin().await.unwrap();
    let deleted = orbitid_credentials::delete_passkey_on(&mut tx, &user.id, &added.id)
        .await
        .unwrap()
        .expect("owned passkey is deleted");
    tx.commit().await.unwrap();
    assert_eq!(deleted.id, added.id);
    assert!(
        orbitid_credentials::delete_passkey(&state.pool, &user.id, &added.id)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn concurrent_finishes_cannot_spend_one_challenge() {
    let context = test_state().await;
    let state = context.state.clone();
    let user = common::insert_user(&state.pool, "user_ada", "ada@example.com").await;
    let rp = relying_party(&state, Some(APP_ORIGIN)).unwrap();
    let begin = begin_passkey_registration(
        &state,
        BeginRegistrationInput {
            user_id: user.id.clone(),
            user_name: "ada".into(),
            display_name: "Ada".into(),
            rp: rp.clone(),
            authenticator_type: None,
            name: None,
        },
    )
    .await
    .unwrap();
    let mut authenticator = software_authenticator();
    let credential = authenticator.register(&begin.options, CredentialOverrides::default());
    let attempt = |state: orbitid_core::AppState,
                   passkey_id: String,
                   user_id: String,
                   credential: orbitid_credentials::RegistrationResponseJson| async move {
        finish_passkey_registration(
            &state,
            FinishRegistrationInput {
                passkey_id,
                user_id,
                credential,
                name: None,
            },
        )
        .await
    };
    let first = tokio::spawn(attempt(
        state.clone(),
        begin.passkey_id.clone(),
        user.id.clone(),
        credential.clone(),
    ));
    let second = tokio::spawn(attempt(
        state.clone(),
        begin.passkey_id,
        user.id.clone(),
        credential,
    ));
    let first = first.await.unwrap();
    let second = second.await.unwrap();
    assert_eq!(
        [first.is_ok(), second.is_ok()]
            .iter()
            .filter(|ok| **ok)
            .count(),
        1
    );
    assert_eq!(list_passkeys(&state.pool, &user.id).await.unwrap().len(), 1);
}
