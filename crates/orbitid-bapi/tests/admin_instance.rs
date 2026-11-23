//! Ported from the retired TypeScript test suite.

mod common;

use std::sync::Arc;

use axum::http::StatusCode;
use orbitid_platform::mail::{
    get_mail_outbox, set_mail_transport, MailTransportOverride, SentEmail,
};
use serde_json::{json, Value};

use common::{error_code, setup, Harness};

const TOTP_SECRET: &str = "JBSWY3DPEHPK3PXP";

struct OkTransport;

#[async_trait::async_trait]
impl MailTransportOverride for OkTransport {
    async fn deliver(&self, _email: &SentEmail) -> orbitid_core::Result<()> {
        Ok(())
    }
}

async fn create_user(harness: &Harness, body: Value) -> Value {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let mut body = body;
    let object = body.as_object_mut().expect("object body");
    if !object.contains_key("email_address") {
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        object.insert(
            "email_address".into(),
            json!([format!("instance-{n}@example.com")]),
        );
    }
    if !object.contains_key("password") {
        object.insert("password".into(), json!("Sup3r-secret!"));
    }
    let response = harness.post("/v1/users", body).await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    response.value()
}

#[tokio::test]
async fn masks_stored_secrets_and_flags_them_as_set() {
    let harness = setup().await;
    harness
        .state()
        .settings
        .update(json!({
            "application": { "name": "Acme Auth", "homeUrl": "https://auth.example.com" },
            "email": { "smtpUrl": "smtp://mailer:hunter2@smtp.example.com:587" },
            "sms": { "twilioAuthToken": "twilio-auth-token" },
            "security": { "captchaSecret": "captcha-secret" },
            "social": { "google": { "enabled": true, "clientId": "google-client-id", "clientSecret": "google-client-secret" } },
        }))
        .await
        .expect("settings update");

    let instance = harness.get("/v1/instance").await;
    assert_eq!(instance.status, StatusCode::OK, "{}", instance.text());
    let value = instance.value();
    assert_eq!(value["object"], json!("instance"));
    assert_eq!(value["environment_type"], json!("development"));
    assert_eq!(
        value["publishable_key"].as_str(),
        Some(harness.state().publishable_key.as_str())
    );
    assert_eq!(value["application"]["name"], json!("Acme Auth"));
    assert_eq!(value["email"]["smtpUrl"], json!("••••"));
    assert_eq!(value["email"]["smtpUrlSet"], json!(true));
    assert_eq!(value["sms"]["twilioAuthToken"], json!("••••"));
    assert_eq!(value["sms"]["twilioAuthTokenSet"], json!(true));
    assert_eq!(value["security"]["captchaSecret"], json!("••••"));
    assert_eq!(value["security"]["captchaSecretSet"], json!(true));
    assert_eq!(value["social"]["google"]["enabled"], json!(true));
    assert_eq!(
        value["social"]["google"]["clientId"],
        json!("google-client-id")
    );
    assert_eq!(value["social"]["google"]["clientSecret"], json!("••••"));
    assert_eq!(value["social"]["google"]["clientSecretSet"], json!(true));
    let text = instance.text().to_string();
    for secret in [
        "smtp://mailer:hunter2@smtp.example.com:587",
        "twilio-auth-token",
        "captcha-secret",
        "google-client-secret",
    ] {
        assert!(!text.contains(secret), "{secret} leaked");
    }
}

#[tokio::test]
async fn keeps_secrets_when_the_mask_is_sent_back_and_validates_urls() {
    let harness = setup().await;
    harness
        .state()
        .settings
        .update(json!({
            "application": { "name": "Acme Auth", "homeUrl": "https://auth.example.com" },
            "email": { "smtpUrl": "smtp://mailer:hunter2@smtp.example.com:587" },
            "social": { "google": { "enabled": true, "clientId": "google-client-id", "clientSecret": "google-client-secret" } },
        }))
        .await
        .expect("settings update");

    let patched = harness
        .patch(
            "/v1/instance",
            json!({
                "application": { "name": "Renamed", "allowedOrigins": ["https://app.example.com"] },
                "email": { "smtpUrl": "••••", "smtpUrlSet": true },
                "social": { "google": { "clientSecret": "••••" } },
            }),
        )
        .await;
    assert_eq!(patched.status, StatusCode::OK, "{}", patched.text());
    assert_eq!(patched.value()["application"]["name"], json!("Renamed"));
    assert_eq!(
        patched.value()["application"]["allowedOrigins"],
        json!(["https://app.example.com"])
    );
    assert_eq!(
        patched.value()["application"]["homeUrl"],
        json!("https://auth.example.com")
    );
    assert_eq!(patched.value()["email"]["smtpUrl"], json!("••••"));
    assert_eq!(
        patched.value()["social"]["google"]["clientId"],
        json!("google-client-id")
    );

    let settings = harness.state().settings.get();
    assert_eq!(
        settings.email.smtp_url,
        "smtp://mailer:hunter2@smtp.example.com:587"
    );
    assert_eq!(
        settings
            .social
            .get("google")
            .map(|config| config.client_secret.as_str()),
        Some("google-client-secret")
    );

    for body in [
        json!({ "application": { "allowedOrigins": ["not-a-url"] } }),
        json!({ "application": { "homeUrl": "javascript:alert(1)" } }),
        json!({ "application": { "allowedRedirectOrigins": [42] } }),
        json!({ "password": { "minLength": 0 } }),
    ] {
        let response = harness.patch("/v1/instance", body.clone()).await;
        assert_eq!(response.status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    }
    assert_eq!(
        harness.state().settings.get().application.home_url,
        "https://auth.example.com"
    );
}

#[tokio::test]
async fn refuses_an_organization_role_setting_that_names_a_missing_role() {
    let harness = setup().await;
    assert_eq!(
        harness
            .patch(
                "/v1/instance",
                json!({ "organizations": { "creatorRole": "org:admin", "defaultRole": "org:member" } }),
            )
            .await
            .status,
        StatusCode::OK
    );

    for field in ["creatorRole", "defaultRole"] {
        for key in ["org:nope", "app:support"] {
            let body = json!({ "organizations": { field: key } });
            let response = harness.patch("/v1/instance", body).await;
            assert_eq!(
                response.status,
                StatusCode::UNPROCESSABLE_ENTITY,
                "{field} {key}"
            );
            assert_eq!(
                response.value()["errors"][0]["meta"]["param_name"],
                json!(format!("organizations.{field}"))
            );
        }
    }
}

#[tokio::test]
async fn sends_a_test_email_and_reports_a_typed_failure() {
    let harness = setup().await;
    harness
        .state()
        .settings
        .update(json!({ "application": { "supportEmail": "help@example.com" } }))
        .await
        .expect("settings");
    set_mail_transport(harness.state(), Some(Arc::new(OkTransport)));

    let sent = harness.post("/v1/instance/test_email", json!({})).await;
    assert_eq!(sent.status, StatusCode::OK, "{}", sent.text());
    assert_eq!(
        sent.value(),
        json!({ "status": "ok", "to": "help@example.com" })
    );
    let outbox = get_mail_outbox(harness.state());
    assert_eq!(
        outbox.last().map(|email| email.to.as_str()),
        Some("help@example.com")
    );

    let explicit = harness
        .post(
            "/v1/instance/test_email",
            json!({ "to": "ops@example.com" }),
        )
        .await;
    assert_eq!(explicit.status, StatusCode::OK);
    let outbox = get_mail_outbox(harness.state());
    assert_eq!(
        outbox.last().map(|email| email.to.as_str()),
        Some("ops@example.com")
    );

    // With no transport configured the legacy route reports the typed failure.
    set_mail_transport(harness.state(), None);
    let failed = harness
        .post(
            "/v1/instance/test_email",
            json!({ "to": "ops@example.com" }),
        )
        .await;
    assert_eq!(failed.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(error_code(&failed).as_deref(), Some("email_not_configured"));

    // A malformed recipient is the caller's mistake: 422, not a transport 503.
    let invalid = harness
        .post("/v1/instance/test_email", json!({ "to": "not-an-email" }))
        .await;
    assert_eq!(invalid.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        error_code(&invalid).as_deref(),
        Some("form_param_format_invalid")
    );
}

#[tokio::test]
async fn reports_the_default_localhost_fallback_as_an_invalid_recipient() {
    // The TS test mocks `sendEmail`, so it never runs `normalizeRecipient` and
    // expects 200 for the default `OrbitID <no-reply@localhost>` From header.
    // The real TS production path (like this port) normalizes the recipient
    // first and rejects `no-reply@localhost` because its domain is not dotted.
    let harness = setup().await;
    set_mail_transport(harness.state(), Some(Arc::new(OkTransport)));
    assert!(harness
        .state()
        .settings
        .get()
        .email
        .from
        .contains("OrbitID"));
    let response = harness.post("/v1/instance/test_email", json!({})).await;
    assert_eq!(response.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        error_code(&response).as_deref(),
        Some("form_param_format_invalid")
    );
}

#[tokio::test]
async fn rotates_the_instance_signing_key() {
    let harness = setup().await;
    let first = harness.post_empty("/v1/instance/signing_keys/rotate").await;
    assert_eq!(first.status, StatusCode::OK, "{}", first.text());
    assert_eq!(first.value()["object"], json!("signing_key"));
    assert_eq!(first.value()["algorithm"], json!("RS256"));
    assert_eq!(first.value()["active"], json!(true));
    let kid = first.value()["kid"].as_str().unwrap().to_string();

    let keys: Vec<(String, bool)> = sqlx::query_as("SELECT kid, active FROM signing_keys")
        .fetch_all(&harness.state().pool)
        .await
        .expect("keys");
    assert_eq!(keys.len(), 1);
    assert_eq!(keys[0].0, kid);

    let second = harness.post_empty("/v1/instance/signing_keys/rotate").await;
    assert_ne!(second.value()["kid"].as_str(), Some(kid.as_str()));
    let keys: Vec<(String, bool)> = sqlx::query_as("SELECT kid, active FROM signing_keys")
        .fetch_all(&harness.state().pool)
        .await
        .expect("keys");
    assert_eq!(keys.iter().filter(|(_, active)| *active).count(), 1);
    assert!(!keys.iter().find(|(key, _)| key == &kid).unwrap().1);
}

#[tokio::test]
async fn issues_testing_tokens_and_respects_the_setting() {
    let harness = setup().await;
    let created = harness.post_empty("/v1/testing_tokens").await;
    assert_eq!(created.status, StatusCode::OK, "{}", created.text());
    assert_eq!(created.value()["object"], json!("testing_token"));
    let token = created.value()["token"].as_str().unwrap().to_string();
    assert!(token.starts_with("tt_"));
    assert!(created.value()["expires_at"].as_i64().unwrap() > orbitid_core::http::now());

    let hash: String =
        sqlx::query_scalar("SELECT token_hash FROM verifications WHERE purpose = 'testing_token'")
            .fetch_one(&harness.state().pool)
            .await
            .expect("testing token row");
    assert_eq!(hash, orbitid_core::crypto::sha256(&token));

    harness
        .state()
        .settings
        .update(json!({ "security": { "testingTokensEnabled": false } }))
        .await
        .expect("settings");
    assert_eq!(
        harness.post_empty("/v1/testing_tokens").await.status,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn records_mutations_and_filters_audit_logs() {
    let harness = setup().await;
    let user = create_user(&harness, json!({})).await;
    let id = user["id"].as_str().unwrap().to_string();
    harness.post_empty(&format!("/v1/users/{id}/ban")).await;

    let logs = harness.get("/v1/audit_logs").await;
    assert_eq!(logs.status, StatusCode::OK, "{}", logs.text());
    assert!(logs.value()["total_count"].as_i64().unwrap() >= 2);
    assert!(logs.value()["data"]
        .as_array()
        .unwrap()
        .iter()
        .all(|log| log["object"] == json!("audit_log")));

    let created = harness
        .get("/v1/audit_logs?action=user.created&target_type=user")
        .await;
    assert_eq!(created.value()["data"][0]["target_id"], json!(id));
    assert_eq!(created.value()["data"][0]["actor"], json!("secret_key"));

    let banned = harness.get("/v1/audit_logs?action=user.*").await;
    let actions: Vec<String> = banned.value()["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|log| log["action"].as_str().unwrap_or_default().to_string())
        .collect();
    assert!(actions.contains(&"user.banned".to_string()));
    assert!(actions.contains(&"user.created".to_string()));

    assert_eq!(
        harness.get("/v1/audit_logs?limit=1").await.value()["data"]
            .as_array()
            .map(Vec::len),
        Some(1)
    );
    assert_eq!(
        harness
            .get(&format!("/v1/audit_logs?target_id={id}"))
            .await
            .value()["total_count"],
        json!(2)
    );
}

#[tokio::test]
async fn aggregates_instance_statistics() {
    let harness = setup().await;
    let active = create_user(&harness, json!({ "email_address": ["s1@example.com"] })).await;
    create_user(
        &harness,
        json!({ "email_address": ["s2@example.com"], "totp_secret": TOTP_SECRET }),
    )
    .await;
    let banned = create_user(&harness, json!({ "email_address": ["s3@example.com"] })).await;
    let locked = create_user(&harness, json!({ "email_address": ["s4@example.com"] })).await;
    harness
        .post_empty(&format!("/v1/users/{}/ban", banned["id"].as_str().unwrap()))
        .await;
    harness
        .post_empty(&format!(
            "/v1/users/{}/lock",
            locked["id"].as_str().unwrap()
        ))
        .await;
    harness.create_session(active["id"].as_str().unwrap()).await;

    let org_id = orbitid_core::ids::new_id("org");
    sqlx::query(
        "INSERT INTO organizations (id, name, public_metadata, private_metadata, created_at, updated_at) \
         VALUES ($1, 'Acme', '{}', '{}', 1, 1)",
    )
    .bind(&org_id)
    .execute(&harness.state().pool)
    .await
    .expect("org");
    for (index, provider) in ["google", "google", "github"].iter().enumerate() {
        sqlx::query(
            "INSERT INTO external_accounts (id, user_id, provider, provider_user_id, \
             public_metadata, created_at, updated_at) VALUES ($1,$2,$3,$4,'{}',1,1)",
        )
        .bind(orbitid_core::ids::new_id(
            orbitid_core::ids::id_prefix::EXTERNAL,
        ))
        .bind(active["id"].as_str().unwrap())
        .bind(*provider)
        .bind(format!("{provider}-{index}"))
        .execute(&harness.state().pool)
        .await
        .expect("external account");
    }

    let stats = harness.get("/v1/stats").await;
    assert_eq!(stats.status, StatusCode::OK, "{}", stats.text());
    let value = stats.value();
    assert_eq!(value["users_total"], json!(4));
    assert_eq!(value["banned_users"], json!(1));
    assert_eq!(value["locked_users"], json!(1));
    assert_eq!(value["mfa_enabled_users"], json!(1));
    assert_eq!(value["organizations_total"], json!(1));
    assert_eq!(value["sessions_active"], json!(1));
    assert_eq!(value["signups_by_day"].as_array().map(Vec::len), Some(30));
    let signups: i64 = value["signups_by_day"]
        .as_array()
        .unwrap()
        .iter()
        .map(|day| day["count"].as_i64().unwrap_or_default())
        .sum();
    assert_eq!(signups, 4);
    let signins: i64 = value["signins_by_day"]
        .as_array()
        .unwrap()
        .iter()
        .map(|day| day["count"].as_i64().unwrap_or_default())
        .sum();
    assert_eq!(signins, 1);
    assert_eq!(
        value["top_social_providers"],
        json!([
            { "provider": "google", "count": 2 },
            { "provider": "github", "count": 1 }
        ])
    );
}

#[tokio::test]
async fn keeps_replaces_and_clears_secrets() {
    let harness = setup().await;
    let smtp = "smtp://mailer:hunter2@smtp.example.com:587";
    let resend = "re_live_abcdefghijklmnop";
    harness
        .state()
        .settings
        .update(json!({
            "email": { "smtpUrl": smtp, "resendApiKey": resend },
            "sms": { "twilioAuthToken": "twilio-auth-token" },
            "security": { "captchaSecret": "captcha-secret" },
            "social": { "google": { "enabled": true, "clientId": "google-id", "clientSecret": "google-secret" } },
        }))
        .await
        .expect("settings");

    // A full-object round trip echoes the masks back; the stored values survive.
    let instance = harness.get("/v1/instance").await.value();
    let mut full = instance.clone();
    full["application"]["name"] = json!("Renamed");
    let patched = harness.patch("/v1/instance", full).await;
    assert_eq!(patched.status, StatusCode::OK, "{}", patched.text());
    let settings = harness.state().settings.get();
    assert_eq!(settings.email.smtp_url, smtp);
    assert_eq!(settings.email.resend_api_key, resend);
    assert_eq!(settings.sms.twilio_auth_token, "twilio-auth-token");
    assert_eq!(settings.security.captcha_secret, "captcha-secret");
    assert_eq!(
        settings
            .social
            .get("google")
            .map(|config| config.client_secret.as_str()),
        Some("google-secret")
    );

    // Sending the plaintext back unchanged keeps it; a new value replaces it.
    harness
        .patch(
            "/v1/instance",
            json!({ "email": { "smtpUrl": smtp, "resendApiKey": resend } }),
        )
        .await;
    assert_eq!(harness.state().settings.get().email.resend_api_key, resend);
    harness
        .patch(
            "/v1/instance",
            json!({ "email": { "resendApiKey": "re_live_replacement_value" } }),
        )
        .await;
    assert_eq!(
        harness.state().settings.get().email.resend_api_key,
        "re_live_replacement_value"
    );

    // An empty string clears the slot.
    let cleared = harness
        .patch(
            "/v1/instance",
            json!({ "security": { "captchaSecret": "" } }),
        )
        .await;
    assert_eq!(
        cleared.value()["security"]["captchaSecretSet"],
        json!(false)
    );
    assert_eq!(harness.state().settings.get().security.captcha_secret, "");
}

#[tokio::test]
async fn reports_the_email_transport_the_server_resolves() {
    let harness = setup().await;
    let initial = harness.get("/v1/instance").await.value();
    assert!(
        matches!(
            initial["email_delivery"]["provider"].as_str(),
            Some("console" | "smtp" | "resend")
        ),
        "{initial}"
    );

    harness
        .state()
        .settings
        .update(json!({
            "email": { "provider": "smtp", "smtpUrl": "smtp://mailer:hunter2@smtp.example.com:587" },
        }))
        .await
        .expect("settings update");
    let configured = harness.get("/v1/instance").await.value();
    assert_eq!(configured["email_delivery"], json!({ "provider": "smtp" }));
}

#[tokio::test]
async fn reports_the_running_version_and_the_cached_release_check() {
    let harness = setup().await;
    let initial = harness.get("/v1/instance").await.value();
    let version = &initial["version"];
    assert_eq!(
        version["current"].as_str(),
        Some(orbitid_platform::current_version())
    );
    // No worker runs in tests, so nothing was fetched and nothing is claimed.
    assert_eq!(version["latest"], Value::Null);
    assert_eq!(version["update_available"], json!(false));
    assert_eq!(version["release_url"], Value::Null);

    // An answer recorded by the worker is read from memory, without a request.
    let newer = orbitid_platform::release::parse_release(&json!({ "tag_name": "v999.0.0" }))
        .expect("release");
    orbitid_platform::release_check(harness.state()).record(Ok(newer), 42);
    let after = harness.get("/v1/instance").await.value();
    let after = &after["version"];
    if harness.state().env.update_check {
        assert_eq!(after["update_check"], json!(true));
        assert_eq!(after["latest"], json!("999.0.0"));
        assert_eq!(after["update_available"], json!(true));
        assert_eq!(
            after["release_url"],
            json!("https://github.com/chark1es/orbitid/releases/tag/v999.0.0")
        );
        assert_eq!(after["checked_at"], json!(42));
    } else {
        // ORBITID_UPDATE_CHECK=false in this environment: nothing is reported.
        assert_eq!(after["update_check"], json!(false));
        assert_eq!(after["latest"], Value::Null);
        assert_eq!(after["update_available"], json!(false));
    }
}
