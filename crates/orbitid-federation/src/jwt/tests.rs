use super::*;

#[test]
fn decode_claims_accepts_a_real_payload() {
    let token = format!(
        "{}.{}.{}",
        base64::Engine::encode(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD,
            br#"{"alg":"RS256"}"#
        ),
        base64::Engine::encode(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD,
            br#"{"sub":"abc","email":"a@example.com"}"#
        ),
        ""
    );
    let claims = decode_claims(&token).expect("claims");
    assert_eq!(claims["sub"], "abc");
}

#[test]
fn verifies_an_es256_token_against_an_ec_jwks() {
    use jsonwebtoken::{encode, EncodingKey, Header};
    use serde_json::json;

    let key = crate::test_support::make_ec_key_pair("jwt").expect("key");
    let (x, y) = crate::test_support::ec_jwk_parts(&key.key).expect("parts");
    let jwks: JwkSet = serde_json::from_value(json!({
        "keys": [{
            "kty": "EC", "crv": "P-256", "x": x, "y": y,
            "kid": "k1", "alg": "ES256", "use": "sig"
        }]
    }))
    .expect("jwks");
    let mut header = Header::new(Algorithm::ES256);
    header.kid = Some("k1".into());
    let now = crate::http::now_ms() / 1000;
    let token = encode(
        &header,
        &json!({ "iss": "https://issuer", "aud": "client", "sub": "u1", "exp": now + 600 }),
        &EncodingKey::from_ec_pem(key.private_key_pem.as_bytes()).expect("signing key"),
    )
    .expect("token");
    let claims = verify_id_token(&jwks, &token, Some("https://issuer"), "client", 0, None)
        .expect("verified");
    assert_eq!(claims["sub"], "u1");
}

fn signed(claims: serde_json::Value) -> (JwkSet, String) {
    use jsonwebtoken::{encode, EncodingKey, Header};
    use serde_json::json;
    let key = crate::test_support::make_ec_key_pair("jwt").expect("key");
    let (x, y) = crate::test_support::ec_jwk_parts(&key.key).expect("parts");
    let jwks: JwkSet = serde_json::from_value(json!({
        "keys": [{ "kty": "EC", "crv": "P-256", "x": x, "y": y,
                   "kid": "k1", "alg": "ES256", "use": "sig" }]
    }))
    .expect("jwks");
    let mut header = Header::new(Algorithm::ES256);
    header.kid = Some("k1".into());
    let token = encode(
        &header,
        &claims,
        &EncodingKey::from_ec_pem(key.private_key_pem.as_bytes()).expect("signing key"),
    )
    .expect("token");
    (jwks, token)
}

fn base_claims() -> serde_json::Value {
    let now = crate::http::now_ms() / 1000;
    serde_json::json!({ "iss": "https://issuer", "aud": "client", "sub": "u1", "exp": now + 600 })
}

fn check(claims: serde_json::Value, issuer: Option<&str>, aud: &str, leeway: u64) -> bool {
    let (jwks, token) = signed(claims);
    verify_id_token(&jwks, &token, issuer, aud, leeway, None).is_ok()
}

#[test]
fn required_and_time_claims_are_enforced() {
    let iss = Some("https://issuer");
    let now = crate::http::now_ms() / 1000;
    assert!(check(base_claims(), iss, "client", 0));

    let mut no_aud = base_claims();
    no_aud.as_object_mut().expect("obj").remove("aud");
    assert!(!check(no_aud, iss, "client", 0), "missing aud must fail");

    let mut no_iss = base_claims();
    no_iss.as_object_mut().expect("obj").remove("iss");
    assert!(
        !check(no_iss.clone(), iss, "client", 0),
        "missing iss must fail"
    );
    assert!(
        check(no_iss, None, "client", 0),
        "no issuer configured: iss optional"
    );

    let mut future = base_claims();
    future["nbf"] = serde_json::json!(4_102_444_800_u64);
    assert!(
        !check(future, iss, "client", 60),
        "far-future nbf must fail"
    );

    let mut near = base_claims();
    near["nbf"] = serde_json::json!(now + 30);
    assert!(
        check(near.clone(), iss, "client", 60),
        "nbf within leeway passes"
    );
    assert!(
        !check(near, iss, "client", 0),
        "nbf in the future without leeway fails"
    );

    assert!(!check(base_claims(), iss, "other", 0), "wrong aud fails");
    assert!(
        !check(base_claims(), Some("https://evil"), "client", 0),
        "wrong iss fails"
    );
}

fn with(key: &str, value: serde_json::Value) -> serde_json::Value {
    let mut claims = base_claims();
    claims[key] = value;
    claims
}

const ISS: Option<&str> = Some("https://issuer");

#[test]
fn rejects_negative_exp() {
    assert!(!check(with("exp", serde_json::json!(-1)), ISS, "client", 0));
}

#[test]
fn rejects_string_exp() {
    assert!(!check(
        with("exp", serde_json::json!("1")),
        ISS,
        "client",
        0
    ));
}

#[test]
fn rejects_null_exp() {
    assert!(!check(
        with("exp", serde_json::Value::Null),
        ISS,
        "client",
        0
    ));
}

#[test]
fn rejects_string_nbf() {
    assert!(!check(
        with("nbf", serde_json::json!("4102444800")),
        ISS,
        "client",
        0
    ));
}

#[test]
fn rejects_null_nbf() {
    assert!(!check(
        with("nbf", serde_json::Value::Null),
        ISS,
        "client",
        0
    ));
}

#[test]
fn rejects_non_number_iat() {
    assert!(!check(
        with("iat", serde_json::json!("1")),
        ISS,
        "client",
        0
    ));
    assert!(!check(
        with("iat", serde_json::Value::Null),
        ISS,
        "client",
        0
    ));
}

#[test]
fn rejects_issuer_array_containing_the_expected_issuer() {
    assert!(!check(
        with("iss", serde_json::json!(["https://evil", "https://issuer"])),
        ISS,
        "client",
        0
    ));
}

#[test]
fn rejects_numeric_issuer() {
    assert!(!check(with("iss", serde_json::json!(5)), ISS, "client", 0));
}

#[test]
fn accepts_valid_claim_shapes() {
    let now = crate::http::now_ms() / 1000;
    assert!(check(
        with("aud", serde_json::json!("client")),
        ISS,
        "client",
        0
    ));
    assert!(check(
        with("aud", serde_json::json!(["other", "client"])),
        ISS,
        "client",
        0
    ));
    let mut no_exp = base_claims();
    no_exp.as_object_mut().expect("obj").remove("exp");
    assert!(check(no_exp, ISS, "client", 0));
    assert!(check(
        with("exp", serde_json::json!(now + 600)),
        ISS,
        "client",
        0
    ));
    assert!(check(
        with("exp", serde_json::json!(now as f64 + 600.5)),
        ISS,
        "client",
        0
    ));
    assert!(check(
        with("nbf", serde_json::json!(now - 5)),
        ISS,
        "client",
        0
    ));
    assert!(check(
        with("nbf", serde_json::json!(now as f64 + 30.5)),
        ISS,
        "client",
        60
    ));
    assert!(check(with("iat", serde_json::json!(now)), ISS, "client", 0));
}

#[test]
fn decode_claims_rejects_garbage() {
    assert!(decode_claims("not-a-jwt").is_err());
    assert!(decode_claims("a.%%%.c").is_err());
}
