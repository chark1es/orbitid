//! Svix-compatible webhook signing, ported from the retired TypeScript server.
//!
//! Scheme: `v1,<base64 hmac-sha256(secretBytes, "id.timestamp.body")>`; the stored
//! secret is `whsec_<base64>`.

use base64::Engine;
use orbitid_core::crypto::{hmac_sha256, safe_equal};
use rand::RngCore;

/// Wait between attempts: after failure #1, #2, ... (`5s, 5m, 30m, 2h, 5h, 10h`),
/// then the delivery is marked failed.
pub const WEBHOOK_RETRY_DELAYS_MS: [i64; 6] =
    [5_000, 300_000, 1_800_000, 7_200_000, 18_000_000, 36_000_000];

pub const WEBHOOK_MAX_ATTEMPTS: i64 = WEBHOOK_RETRY_DELAYS_MS.len() as i64 + 1;

/// `whsec_` + 24 random bytes in standard base64.
pub fn generate_webhook_secret() -> String {
    let mut bytes = [0u8; 24];
    rand::rng().fill_bytes(&mut bytes);
    format!(
        "whsec_{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

/// Node's `Buffer.from(value, "base64")` is lenient: it ignores invalid characters
/// and missing padding.
fn decode_secret(secret: &str) -> Vec<u8> {
    let raw = secret.strip_prefix("whsec_").unwrap_or(secret);
    let mut cleaned: String = raw
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || *character == '+' || *character == '/'
        })
        .collect();
    while cleaned.len() % 4 != 0 {
        cleaned.push('=');
    }
    base64::engine::general_purpose::STANDARD
        .decode(cleaned)
        .unwrap_or_default()
}

fn digest(secret: &str, id: &str, timestamp: &str, body: &str) -> String {
    let key = decode_secret(secret);
    let signed = format!("{id}.{timestamp}.{body}");
    base64::engine::general_purpose::STANDARD.encode(hmac_sha256(&key, signed.as_bytes()))
}

/// `v1,<digest>` for an outbound delivery.
pub fn sign_webhook(secret: &str, id: &str, timestamp: i64, body: &str) -> String {
    format!("v1,{}", digest(secret, id, &timestamp.to_string(), body))
}

#[derive(Clone)]
pub struct WebhookVerificationInput<'a> {
    pub secret: &'a str,
    pub id: Option<&'a str>,
    pub timestamp: Option<&'a str>,
    pub body: &'a str,
    /// Raw `svix-signature` header (may contain several space-separated signatures).
    pub signature: Option<&'a str>,
}

impl<'a> std::fmt::Debug for WebhookVerificationInput<'a> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebhookVerificationInput")
            .field("secret", &"<redacted>")
            .field("id", &self.id)
            .field("timestamp", &self.timestamp)
            .field("body", &self.body)
            .field("signature", &self.signature)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct VerifyOptions {
    /// Rejects replays; 0 disables the timestamp check. Default 300.
    pub tolerance_seconds: Option<i64>,
    /// Current time in milliseconds (default: now).
    pub now: Option<i64>,
}

/// Verify a received webhook.
pub fn verify_webhook_signature(
    input: &WebhookVerificationInput<'_>,
    options: VerifyOptions,
) -> bool {
    let (Some(id), Some(timestamp), Some(signature)) = (input.id, input.timestamp, input.signature)
    else {
        return false;
    };
    if id.is_empty() || timestamp.is_empty() || signature.is_empty() {
        return false;
    }
    let tolerance = options.tolerance_seconds.unwrap_or(300);
    if tolerance > 0 {
        let Ok(seconds) = timestamp.trim().parse::<f64>() else {
            return false;
        };
        if !seconds.is_finite() {
            return false;
        }
        let now = options.now.unwrap_or_else(orbitid_core::http::now);
        let age = (now as f64 / 1000.0 - seconds).abs();
        if age > tolerance as f64 {
            return false;
        }
    }
    let expected = digest(input.secret, id, timestamp, input.body);
    signature.split(' ').any(|part| {
        let mut pieces = part.splitn(2, ',');
        let version = pieces.next().unwrap_or("");
        let value = pieces.next().unwrap_or("");
        version == "v1" && !value.is_empty() && safe_equal(value, &expected)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signatures_verify_and_tampering_fails() {
        let secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
        let body = r#"{"hello":"world"}"#;
        let timestamp = orbitid_core::http::now() / 1000;
        let signature = sign_webhook(secret, "evt_1", timestamp, body);
        assert!(signature.starts_with("v1,"));

        let verify = |id: &str, timestamp: i64, body: &str, signature: &str| {
            verify_webhook_signature(
                &WebhookVerificationInput {
                    secret,
                    id: Some(id),
                    timestamp: Some(&timestamp.to_string()),
                    body,
                    signature: Some(signature),
                },
                VerifyOptions::default(),
            )
        };
        assert!(verify("evt_1", timestamp, body, &signature));
        assert!(!verify("evt_1", timestamp, &format!("{body} "), &signature));
        assert!(!verify("evt_2", timestamp, body, &signature));

        let stale = timestamp - 400;
        let stale_signature = sign_webhook(secret, "evt_1", stale, body);
        assert!(!verify("evt_1", stale, body, &stale_signature));
        let unchecked = verify_webhook_signature(
            &WebhookVerificationInput {
                secret,
                id: Some("evt_1"),
                timestamp: Some(&stale.to_string()),
                body,
                signature: Some(&stale_signature),
            },
            VerifyOptions {
                tolerance_seconds: Some(0),
                now: None,
            },
        );
        assert!(unchecked);
        assert!(!verify_webhook_signature(
            &WebhookVerificationInput {
                secret: "whsec_b3RoZXI=",
                id: Some("evt_1"),
                timestamp: Some(&timestamp.to_string()),
                body,
                signature: Some(&signature),
            },
            VerifyOptions::default(),
        ));
    }

    #[test]
    fn signature_is_byte_identical_to_typescript() {
        assert_eq!(
            sign_webhook(
                "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
                "evt_1",
                1_700_000_000,
                r#"{"hello":"world"}"#
            ),
            "v1,fzws8/9/VAI0pfE8P9NqsL4LB93x2veBYrbkmXN93Sw="
        );
    }

    #[test]
    fn secrets_are_whsec_base64() {
        let secret = generate_webhook_secret();
        let encoded = secret.strip_prefix("whsec_").unwrap_or("");
        assert_eq!(encoded.len(), 32);
        assert!(encoded
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/'));
    }

    #[test]
    fn multiple_signatures_are_accepted() {
        let secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
        let timestamp = orbitid_core::http::now() / 1000;
        let body = "{}";
        let good = sign_webhook(secret, "evt_1", timestamp, body);
        let combined = format!("v1,bm90LXRoZS1zaWduYXR1cmU= {good}");
        assert!(verify_webhook_signature(
            &WebhookVerificationInput {
                secret,
                id: Some("evt_1"),
                timestamp: Some(&timestamp.to_string()),
                body,
                signature: Some(&combined),
            },
            VerifyOptions::default(),
        ));
    }
}
