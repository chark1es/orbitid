use super::*;
use crate::profiles::bool_or_undefined;
use serde_json::json;

fn cfg() -> OAuthProviderConfig {
    OAuthProviderConfig {
        key: "custom_test".into(),
        name: "Test".into(),
        client_id: "id".into(),
        client_secret: "secret".into(),
        scopes: vec![],
        discovery_url: None,
        protocol: Some(SocialProtocol::Oidc),
        authorization_url: None,
        token_url: None,
        userinfo_url: None,
        jwks_url: None,
        issuer: None,
        client_auth_method: None,
        pkce: None,
        trust_email_verified: None,
        logo_url: None,
        claim_mapping: None,
        apple_team_id: None,
        apple_key_id: None,
        apple_private_key: None,
    }
}

fn tokens() -> OAuthTokenSet {
    OAuthTokenSet::default()
}

#[test]
fn trust_only_fills_an_absent_claim() {
    let mut trusted = cfg();
    trusted.trust_email_verified = Some(true);
    let explicit_false = mapped_profile(
        &trusted,
        &json!({ "sub": "1", "email": "victim@example.com", "email_verified": false }),
        &tokens(),
    )
    .unwrap();
    assert_eq!(explicit_false.email_verified, Some(false));
    assert!(!explicit_false.email_may_link());

    let string_false = mapped_profile(
        &trusted,
        &json!({ "sub": "2", "email": "victim@example.com", "email_verified": "false" }),
        &tokens(),
    )
    .unwrap();
    assert_eq!(string_false.email_verified, Some(false));

    let numeric_false = mapped_profile(
        &trusted,
        &json!({ "sub": "3", "email": "victim@example.com", "email_verified": 0 }),
        &tokens(),
    )
    .unwrap();
    assert_eq!(numeric_false.email_verified, Some(false));

    let absent = mapped_profile(
        &trusted,
        &json!({ "sub": "4", "email": "ada@example.com" }),
        &tokens(),
    )
    .unwrap();
    assert_eq!(absent.email_verified, Some(true));
    assert!(absent.email_may_link());

    let mut untrusted = trusted.clone();
    untrusted.trust_email_verified = Some(false);
    let absent = mapped_profile(
        &untrusted,
        &json!({ "sub": "5", "email": "ada@example.com" }),
        &tokens(),
    )
    .unwrap();
    assert_eq!(absent.email_verified, Some(false));
    assert!(!absent.email_may_link());
}

#[test]
fn claim_mapping_uses_dotted_paths() {
    let mut mapped = cfg();
    mapped.protocol = Some(SocialProtocol::Oauth2);
    mapped.claim_mapping = Some(orbitid_core::settings::types::ClaimMapping {
        sub: "data.profile.id".into(),
        email: "data.profile.contact.email".into(),
        email_verified: "data.profile.contact.verified".into(),
        name: "data.profile.display_name".into(),
        first_name: String::new(),
        last_name: String::new(),
        username: "data.profile.login".into(),
        picture: "data.profile.avatar.url".into(),
    });
    let profile = mapped_profile(
        &mapped,
        &json!({ "data": { "profile": {
            "id": "nested-user-1",
            "contact": { "email": "ada@nested.test", "verified": "true" },
            "display_name": "Ada Lovelace",
            "login": "ada",
            "avatar": { "url": "https://img.example/ada.png" }
        }}}),
        &tokens(),
    )
    .unwrap();
    assert_eq!(profile.provider_user_id, "nested-user-1");
    assert_eq!(profile.email.as_deref(), Some("ada@nested.test"));
    assert_eq!(profile.email_verified, Some(true));
    assert_eq!(profile.first_name.as_deref(), Some("Ada"));
    assert_eq!(profile.last_name.as_deref(), Some("Lovelace"));
    assert_eq!(profile.username.as_deref(), Some("ada"));
    assert_eq!(
        profile.image_url.as_deref(),
        Some("https://img.example/ada.png")
    );
}

#[test]
fn a_profile_without_a_subject_is_refused() {
    let error = mapped_profile(&cfg(), &json!({ "email": "a@x" }), &tokens()).unwrap_err();
    assert_eq!(error.code, "oauth_callback_error");
    assert!(error.message.contains("without a subject"));
}

#[test]
fn oauth2_protocol_is_recognized() {
    let mut value = cfg();
    assert!(!is_oauth2_provider(&value));
    value.protocol = Some(SocialProtocol::Oauth2);
    assert!(is_oauth2_provider(&value));
    value.protocol = None;
    assert!(!is_oauth2_provider(&value));
}

#[test]
fn verified_claim_accepts_the_provider_spellings() {
    for (value, expected) in [
        (json!(true), Some(true)),
        (json!(false), Some(false)),
        (json!("TRUE"), Some(true)),
        (json!("0"), Some(false)),
        (json!(1), Some(true)),
        (json!(0), Some(false)),
        (json!(2), None),
        (json!("maybe"), None),
        (json!(null), None),
    ] {
        assert_eq!(super::mapped::verified_claim(&value), expected, "{value}");
    }
}

#[test]
fn bool_flag_helper_is_exported() {
    assert_eq!(bool_or_undefined(&json!("true")), Some(true));
    assert_eq!(flag(&json!(false)), Some(false));
}
