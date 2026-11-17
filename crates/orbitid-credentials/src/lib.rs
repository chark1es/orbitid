//! L1 credential primitives: instance signing keys, JWTs/JWKS, JWT templates,
//! passwords (argon2/bcrypt/scrypt), TOTP/backup codes and WebAuthn passkeys.
//!
//! Layering: this crate depends only on `orbitid-core`. Where the TypeScript
//! services called users/sessions/orgs/RBAC services, the caller passes the
//! rows and resolved claims (`SessionTokenInput`, `TokenOrg`); JWT templates
//! still read their shortcode tables directly, exactly like the TS service.

pub mod jwt;
pub mod keys;
mod limits;
pub mod mfa;
pub mod passkeys;
pub mod password_digest;
pub mod passwords;
pub mod routes;
pub mod session;
pub mod templates;

pub use jwt::{
    decode_jwt_payload, fetch_remote_jwks, invalidate_remote_jwks, sign_jws, verify_jws, Jwk,
    JwkError, JwkSet, JwsAlgorithm, JwsHeader, RemoteJwksOptions, VerifyOptions, DEFAULT_TTL_MS,
};
pub use keys::{
    assert_signing_keys_readable, generate_signing_key, get_active_signing_key, get_jwks,
    rotate_signing_key, ActiveSigningKey, GeneratedSigningKey, INSTANCE_KEY_ALGORITHM,
    UNREADABLE_KEY_HINT,
};
pub use mfa::{
    check_totp_against_secret, consume_backup_code, disable_totp, email_second_factors,
    finish_totp_setup, first_factor_channel, generate_backup_codes, generate_totp_secret,
    hash_backup_code, mask_email, mfa_enrollment_required, mfa_enrollment_required_on,
    qr_code_data_url, regenerate_backup_codes, start_totp_setup, supported_second_factors,
    totp_code_at, totp_matching_step, totp_uri, user_has_mfa, verified_second_factor_phones,
    verify_totp, verify_totp_code_at, verify_totp_once, BackupCodes, SecondFactorOptions,
    TotpSetup,
};
pub use passkeys::webauthn::{
    creation_options, new_challenge, request_options, verify_authentication, verify_registration,
    AuthenticationInfo, AuthenticationResponseData, AuthenticationResponseJson,
    AuthenticatorSelection, CreationOptionsJson, CredentialDescriptor, PubKeyCredParam,
    RegistrationInfo, RegistrationResponseData, RegistrationResponseJson, RequestOptionsJson,
    RpEntity, UserEntity, WebauthnError,
};
pub use passkeys::{
    add_passkey_on, begin_passkey_authentication, begin_passkey_registration, delete_passkey,
    delete_passkey_on, finish_passkey_authentication, finish_passkey_registration, list_passkeys,
    relying_party, AddPasskeyInput, BeginAuthenticationInput, BeginRegistration,
    BeginRegistrationInput, FinishAuthenticationInput, FinishRegistrationInput, RelyingParty,
};
pub use password_digest::{
    parse_scrypt_digest, password_digest_kind, DigestKind, ScryptDigest, MAX_DIGEST_LENGTH,
};
pub use passwords::{
    assert_password_digest, assert_password_hasher, assert_password_policy, assert_password_valid,
    hash_password, is_password_pwned, password_problems, verify_password, PasswordHasher,
    PasswordPolicyProblem, PASSWORD_HASHERS,
};
pub use routes::jwks_router;
pub use session::{
    resolve_shortcode_value, sign_jwt, sign_session_token, verify_session_token, SessionTokenInput,
    SessionTokenOptions, SignJwtOptions, TokenOrg, TokenType, VerifySessionOptions,
};
pub use templates::{
    assert_allowed_claims, build_shortcode_context, default_avatar, generate_template_signing_key,
    import_template_key, render_claims_with_context, render_template_claims, render_template_value,
    stringify_shortcode_value, template_verification_key, RenderedTemplate, TemplateRenderInput,
};

#[cfg(feature = "test-util")]
pub use passkeys::authenticator::{
    CredentialOverrides, VirtualAlgorithm, VirtualAuthenticator, VirtualAuthenticatorOptions,
};
