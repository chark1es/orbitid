//! Apple sign-in: the ES256 client secret, its cache, ID-token verification and
//! the manual `form_post` adapter.

#![cfg(feature = "test-util")]

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};

use async_trait::async_trait;
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use orbitid_core::safe_fetch::{
    set_safe_fetch_transport_for_tests, SafeFetchOptions, SafeFetchResult, SafeFetchTransport,
};
use orbitid_core::testing::test_state;
use orbitid_federation::apple::{apple_client_secret, reset_apple_client_secret_cache};
use orbitid_federation::config::{provider_config, APPLE_ISSUER, APPLE_JWKS_URL, APPLE_TOKEN_URL};
use orbitid_federation::jwt::reset_jwks_cache;
use orbitid_federation::test_support::{
    ec_jwk_parts, make_ec_key_pair, public_key_pem, TestKeyPair,
};
use orbitid_federation::{get_oauth_adapter, ExchangeInput};
use serde_json::{json, Value};
use tokio::sync::Mutex;

static SEAM: Mutex<()> = Mutex::const_new(());
const CLIENT_ID: &str = "com.example.web";
const TEAM_ID: &str = "TEAM123456";
const KEY_ID: &str = "KEY7890123";

struct Canned {
    routes: HashMap<String, String>,
    seen: StdMutex<Vec<(String, Option<String>)>>,
}

#[async_trait]
impl SafeFetchTransport for Canned {
    async fn call(
        &self,
        url: &url::Url,
        options: &SafeFetchOptions,
    ) -> orbitid_core::Result<SafeFetchResult> {
        let body = options
            .body
            .as_ref()
            .map(|body| String::from_utf8_lossy(body).into_owned());
        if let Ok(mut seen) = self.seen.lock() {
            seen.push((url.to_string(), body));
        }
        let response = self.routes.get(url.as_str()).cloned().unwrap_or_default();
        Ok(SafeFetchResult {
            status: 200,
            headers: axum::http::HeaderMap::new(),
            body: response,
        })
    }
}

fn ec_jwks(key: &TestKeyPair) -> String {
    let (x, y) = ec_jwk_parts(&key.key).expect("jwk");
    json!({
        "keys": [{
            "kty": "EC", "crv": "P-256", "x": x, "y": y,
            "kid": KEY_ID, "alg": "ES256", "use": "sig"
        }]
    })
    .to_string()
}

fn sign_id_token(key: &TestKeyPair, sub: &str) -> String {
    let now = orbitid_federation::http::now_ms() / 1000;
    let mut header = Header::new(Algorithm::ES256);
    header.kid = Some(KEY_ID.to_string());
    let claims = json!({
        "iss": APPLE_ISSUER,
        "aud": CLIENT_ID,
        "sub": sub,
        "email": "ada@example.com",
        "email_verified": "true",
        "iat": now,
        "exp": now + 600,
    });
    encode(
        &header,
        &claims,
        &EncodingKey::from_ec_pem(key.private_key_pem.as_bytes()).expect("key"),
    )
    .expect("token")
}

async fn configure_apple(state: &orbitid_core::AppState, secret_key: &TestKeyPair) {
    state
        .settings
        .update(json!({
            "social": { "apple": {
                "enabled": true,
                "clientId": CLIENT_ID,
                "scopes": ["name", "email"],
                "appleTeamId": TEAM_ID,
                "appleKeyId": KEY_ID,
                "applePrivateKey": secret_key.private_key_pem,
            }}
        }))
        .await
        .expect("settings");
}

#[tokio::test]
async fn mints_and_caches_an_es256_client_secret() {
    reset_apple_client_secret_cache();
    let ctx = test_state().await;
    let key = make_ec_key_pair("apple-secret").expect("key");
    configure_apple(&ctx.state, &key).await;
    let cfg = provider_config(&ctx.state, "apple").expect("config");
    let now = orbitid_federation::http::now_ms();

    let first = apple_client_secret(&cfg, now).expect("secret");
    assert_eq!(apple_client_secret(&cfg, now).expect("cached"), first);
    let header = jsonwebtoken::decode_header(&first).expect("header");
    assert_eq!(header.alg, Algorithm::ES256);
    assert_eq!(header.kid.as_deref(), Some(KEY_ID));

    let mut validation = Validation::new(Algorithm::ES256);
    validation.required_spec_claims.clear();
    validation.set_issuer(&[TEAM_ID]);
    validation.set_audience(&[APPLE_ISSUER]);
    let public = public_key_pem(&key.key).expect("public");
    let data = decode::<Value>(
        &first,
        &DecodingKey::from_ec_pem(public.as_bytes()).expect("decoding key"),
        &validation,
    )
    .expect("verified secret");
    assert_eq!(data.claims["iss"], TEAM_ID);
    assert_eq!(data.claims["sub"], CLIENT_ID);
    let lifetime = data.claims["exp"].as_i64().unwrap() - data.claims["iat"].as_i64().unwrap();
    assert!(lifetime <= 180 * 24 * 60 * 60);
    assert!(lifetime > 179 * 24 * 60 * 60);

    // A day before expiry the cached value is still accepted, then renewed.
    assert_eq!(
        apple_client_secret(&cfg, now + 178 * 24 * 60 * 60 * 1000).expect("cached"),
        first
    );
    let renewed =
        apple_client_secret(&cfg, now + (180 * 24 * 60 * 60 - 60) * 1000).expect("renewed");
    assert_ne!(renewed, first);
    decode::<Value>(
        &renewed,
        &DecodingKey::from_ec_pem(public.as_bytes()).expect("decoding key"),
        &validation,
    )
    .expect("renewed verifies");
    reset_apple_client_secret_cache();
}

#[tokio::test]
async fn apple_exchange_sends_the_generated_secret_and_reads_the_verified_token() {
    let _guard = SEAM.lock().await;
    reset_apple_client_secret_cache();
    reset_jwks_cache();
    let ctx = test_state().await;
    let secret_key = make_ec_key_pair("apple-secret").expect("key");
    let id_key = make_ec_key_pair("apple-id").expect("key");
    configure_apple(&ctx.state, &secret_key).await;

    let mut routes = HashMap::new();
    routes.insert(APPLE_JWKS_URL.to_string(), ec_jwks(&id_key));
    routes.insert(
        APPLE_TOKEN_URL.to_string(),
        json!({
            "access_token": "apple-access",
            "refresh_token": "apple-refresh",
            "id_token": sign_id_token(&id_key, "apple-user-7"),
            "expires_in": 3600,
            "token_type": "Bearer",
        })
        .to_string(),
    );
    let transport = Arc::new(Canned {
        routes,
        seen: StdMutex::new(Vec::new()),
    });
    set_safe_fetch_transport_for_tests(Some(transport.clone()));

    let adapter = get_oauth_adapter(&ctx.state, "apple")
        .await
        .expect("adapter")
        .expect("configured");
    let url = adapter
        .create_authorization_url(orbitid_federation::AuthorizationInput {
            state: "apple-state",
            code_verifier: "unused",
            scopes: &["name".into(), "email".into()],
            nonce: None,
        })
        .await
        .expect("url");
    let params: HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(
        params.get("response_mode").map(String::as_str),
        Some("form_post")
    );
    assert_eq!(params.get("scope").map(String::as_str), Some("name email"));
    assert!(!params.contains_key("code_challenge"));
    assert!(!params.contains_key("nonce"));

    let tokens = adapter
        .exchange_code(ExchangeInput {
            code: "apple-code",
            code_verifier: "",
            nonce: None,
        })
        .await
        .expect("exchange");
    assert_eq!(tokens.access_token, "apple-access");
    let profile = adapter.fetch_profile(&tokens).await.expect("profile");
    assert_eq!(profile.provider, "apple");
    assert_eq!(profile.provider_user_id, "apple-user-7");
    assert_eq!(profile.email.as_deref(), Some("ada@example.com"));
    assert_eq!(profile.email_verified, Some(true));

    let seen = transport.seen.lock().expect("seen");
    let (_, body) = seen
        .iter()
        .find(|(url, _)| url == APPLE_TOKEN_URL)
        .expect("token request");
    let form: HashMap<String, String> =
        url::form_urlencoded::parse(body.as_deref().unwrap_or("").as_bytes())
            .into_owned()
            .collect();
    assert_eq!(form.get("code").map(String::as_str), Some("apple-code"));
    assert_eq!(form.get("client_id").map(String::as_str), Some(CLIENT_ID));
    let secret = form.get("client_secret").expect("client secret");
    let header = jsonwebtoken::decode_header(secret).expect("header");
    assert_eq!(header.alg, Algorithm::ES256);
    assert_eq!(header.kid.as_deref(), Some(KEY_ID));
    let public = public_key_pem(&secret_key.key).expect("public");
    let mut validation = Validation::new(Algorithm::ES256);
    validation.required_spec_claims.clear();
    validation.set_issuer(&[TEAM_ID]);
    validation.set_audience(&[APPLE_ISSUER]);
    decode::<Value>(
        secret,
        &DecodingKey::from_ec_pem(public.as_bytes()).expect("key"),
        &validation,
    )
    .expect("secret verifies");

    set_safe_fetch_transport_for_tests(None);
    reset_apple_client_secret_cache();
}

#[tokio::test]
async fn refuses_an_apple_id_token_that_does_not_verify() {
    let _guard = SEAM.lock().await;
    reset_apple_client_secret_cache();
    reset_jwks_cache();
    let ctx = test_state().await;
    let secret_key = make_ec_key_pair("apple-secret").expect("key");
    let id_key = make_ec_key_pair("apple-id").expect("key");
    let stranger = make_ec_key_pair("stranger").expect("key");
    configure_apple(&ctx.state, &secret_key).await;
    let mut routes = HashMap::new();
    routes.insert(APPLE_JWKS_URL.to_string(), ec_jwks(&id_key));
    routes.insert(
        APPLE_TOKEN_URL.to_string(),
        json!({
            "access_token": "apple-access",
            "id_token": sign_id_token(&stranger, "forged"),
            "expires_in": 3600,
        })
        .to_string(),
    );
    set_safe_fetch_transport_for_tests(Some(Arc::new(Canned {
        routes,
        seen: StdMutex::new(Vec::new()),
    })));
    let adapter = get_oauth_adapter(&ctx.state, "apple")
        .await
        .expect("adapter")
        .expect("configured");
    let error = adapter
        .exchange_code(ExchangeInput {
            code: "apple-code",
            code_verifier: "",
            nonce: None,
        })
        .await
        .unwrap_err();
    assert_eq!(error.code, "oauth_callback_error");
    assert!(error.message.contains("verified"));
    set_safe_fetch_transport_for_tests(None);
    reset_apple_client_secret_cache();
}
