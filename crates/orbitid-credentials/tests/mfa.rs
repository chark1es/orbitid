//! TOTP enrollment, backup codes and second-factor discovery.

mod common;

use serde_json::json;

use orbitid_core::http::now;
use orbitid_core::testing::test_state;
use orbitid_credentials::{
    consume_backup_code, disable_totp, finish_totp_setup, generate_backup_codes,
    mfa_enrollment_required, regenerate_backup_codes, start_totp_setup, supported_second_factors,
    totp_code_at, verify_totp, SecondFactorOptions,
};

#[tokio::test]
async fn enrolls_totp_and_consumes_backup_codes_once() {
    let context = test_state().await;
    let state = &context.state;
    let user = common::insert_user(&state.pool, "user_ada", "ada@example.com").await;

    let setup = start_totp_setup(state, &user).await.unwrap();
    assert!(setup.uri.starts_with("otpauth://totp/"));
    assert!(setup.qr_code.starts_with("data:image/png;base64,"));
    let code = totp_code_at(&setup.secret, now() / 1000).unwrap();
    let backup = finish_totp_setup(state, &user, &code).await.unwrap();
    assert_eq!(backup.len(), 10);

    let stored = common::user_row(&state.pool, &user.id).await;
    assert!(stored.totp_verified);
    let encrypted = stored.totp_secret_enc.clone().unwrap();
    assert!(encrypted.starts_with("v1."));
    assert!(!encrypted.contains(&setup.secret));
    assert!(verify_totp(state, &stored, &code));
    assert!(!verify_totp(state, &stored, "000000"));

    assert!(consume_backup_code(&state.pool, &user.id, &backup[0])
        .await
        .unwrap());
    assert!(!consume_backup_code(&state.pool, &user.id, &backup[0])
        .await
        .unwrap());
    // Normalization: the same code in another shape is still spent.
    assert!(!consume_backup_code(
        &state.pool,
        &user.id,
        &backup[0].to_uppercase().replace('-', " ")
    )
    .await
    .unwrap());

    let regenerated = regenerate_backup_codes(&state.pool, &user.id)
        .await
        .unwrap();
    assert_eq!(regenerated.len(), 10);
    assert!(consume_backup_code(&state.pool, &user.id, &regenerated[1])
        .await
        .unwrap());

    disable_totp(&state.pool, &user.id).await.unwrap();
    let cleared = common::user_row(&state.pool, &user.id).await;
    assert!(!cleared.totp_verified);
    assert!(cleared.totp_secret_enc.is_none());
    assert!(cleared.backup_codes.is_none());
}

#[tokio::test]
async fn finish_rejects_a_wrong_code_and_requires_a_pending_secret() {
    let context = test_state().await;
    let state = &context.state;
    let user = common::insert_user(&state.pool, "user_ada", "ada@example.com").await;
    let error = finish_totp_setup(state, &user, "123456").await.unwrap_err();
    assert_eq!(error.code, "totp_not_enabled");

    let setup = start_totp_setup(state, &user).await.unwrap();
    let error = finish_totp_setup(state, &user, "000000").await.unwrap_err();
    assert_eq!(error.code, "form_code_incorrect");
    let code = totp_code_at(&setup.secret, now() / 1000).unwrap();
    assert!(finish_totp_setup(state, &user, &code).await.is_ok());
}

#[tokio::test]
async fn second_factor_discovery_excludes_the_first_factor_channel() {
    let context = test_state().await;
    let state = &context.state;
    state
        .settings
        .update(json!({
            "attributes": {
                "emailAddress": {
                    "enabled": true,
                    "usedForFirstFactor": true,
                    "usedForSecondFactor": true,
                    "verifications": ["email_code"],
                    "verifyAtSignUp": true
                },
                "phoneNumber": {
                    "enabled": true,
                    "usedForFirstFactor": true,
                    "usedForSecondFactor": true,
                    "verifications": ["phone_code"]
                }
            }
        }))
        .await
        .unwrap();
    let user = common::insert_user(&state.pool, "user_ada", "ada@example.com").await;
    common::insert_verified_phone(&state.pool, "idn_p_ada", &user.id, "+15550001111", true).await;
    let setup = start_totp_setup(state, &user).await.unwrap();
    let code = totp_code_at(&setup.secret, now() / 1000).unwrap();
    finish_totp_setup(state, &user, &code).await.unwrap();
    let user = common::user_row(&state.pool, &user.id).await;

    let factors = supported_second_factors(state, &user, SecondFactorOptions::default())
        .await
        .unwrap();
    let strategies: Vec<&str> = factors
        .iter()
        .map(|factor| factor.strategy.as_str())
        .collect();
    assert!(strategies.contains(&"totp"));
    assert!(strategies.contains(&"phone_code"));
    assert!(strategies.contains(&"email_code"));
    assert!(strategies.contains(&"backup_code"));
    assert_eq!(
        factors
            .iter()
            .find(|factor| factor.strategy == "email_code")
            .unwrap()
            .safe_identifier
            .as_deref(),
        Some("a***@example.com")
    );

    // The phone used as the first factor is not offered again.
    let factors = supported_second_factors(
        state,
        &user,
        SecondFactorOptions {
            first_factor_strategy: Some("phone_code".into()),
            first_factor_phone_id: Some("idn_p_ada".into()),
            first_factor_email_id: None,
        },
    )
    .await
    .unwrap();
    assert!(!factors.iter().any(|factor| factor.strategy == "phone_code"));

    // Without the exact phone id the whole channel fails closed.
    let factors = supported_second_factors(
        state,
        &user,
        SecondFactorOptions {
            first_factor_strategy: Some("phone_code".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert!(!factors.iter().any(|factor| factor.strategy == "phone_code"));

    // The email used for a reset is excluded; other addresses remain usable.
    let factors = supported_second_factors(
        state,
        &user,
        SecondFactorOptions {
            first_factor_strategy: Some("reset_password_email_code".into()),
            first_factor_email_id: Some(format!("idn_e_{}", user.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert!(!factors.iter().any(|factor| factor.strategy == "email_code"));
}

#[tokio::test]
async fn required_mfa_only_applies_when_enrollment_is_possible() {
    let context = test_state().await;
    let state = &context.state;
    let user = common::insert_user(&state.pool, "user_ada", "ada@example.com").await;
    state
        .settings
        .update(json!({"mfa": {"required": true}}))
        .await
        .unwrap();
    assert!(!mfa_enrollment_required(state, &user).await.unwrap());
    state
        .settings
        .update(json!({"attributes": {"authenticatorApp": {"enabled": true}}}))
        .await
        .unwrap();
    assert!(mfa_enrollment_required(state, &user).await.unwrap());

    let setup = start_totp_setup(state, &user).await.unwrap();
    let code = totp_code_at(&setup.secret, now() / 1000).unwrap();
    finish_totp_setup(state, &user, &code).await.unwrap();
    let user = common::user_row(&state.pool, &user.id).await;
    assert!(!mfa_enrollment_required(state, &user).await.unwrap());
}

#[test]
fn backup_code_batches_are_unique() {
    let first = generate_backup_codes(10);
    let second = generate_backup_codes(10);
    assert_eq!(first.plain.len(), 10);
    assert_eq!(first.hashed.len(), 10);
    assert!(first.plain.iter().all(|code| code.len() == 11));
    assert!(first
        .plain
        .iter()
        .all(|code| !code.contains('l') && !code.contains('0') && !code.contains('1')));
    assert!(first
        .plain
        .iter()
        .zip(second.plain.iter())
        .all(|(left, right)| left != right));
}
