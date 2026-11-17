//! `Debug` for the environment structs: secrets are redacted.

use super::{Env, EnvOverrides};

/// Placeholder printed instead of a secret in `Debug` output.
const REDACTED: &str = "<redacted>";

fn redacted(value: &str) -> &'static str {
    if value.is_empty() {
        "<unset>"
    } else {
        REDACTED
    }
}

fn redacted_option(value: &Option<String>) -> &'static str {
    match value {
        Some(value) => redacted(value),
        None => "<unset>",
    }
}

impl std::fmt::Debug for Env {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Env")
            .field("port", &self.port)
            .field("base_url", &self.base_url)
            .field("base_url_explicit", &self.base_url_explicit)
            .field("trust_proxy", &self.trust_proxy)
            .field("database", &self.database)
            .field("encryption_key", &redacted(&self.encryption_key))
            .field("encryption_key_provided", &self.encryption_key_provided)
            .field("secret_key", &redacted(&self.secret_key))
            .field("data_dir", &self.data_dir)
            .field("dashboard_dir", &self.dashboard_dir)
            .field("node_env", &self.node_env)
            .field("resend_api_key", &redacted(&self.resend_api_key))
            .field("smtp_url", &redacted(&self.smtp_url))
            .field("email_from", &self.email_from)
            .field("db_max_connections", &self.db_max_connections)
            .field("db_acquire_timeout_ms", &self.db_acquire_timeout_ms)
            .field("request_timeout_ms", &self.request_timeout_ms)
            .field("drain_timeout_ms", &self.drain_timeout_ms)
            .field("allow_private_networks", &self.allow_private_networks)
            .field("webhook_retention_days", &self.webhook_retention_days)
            .field("audit_retention_days", &self.audit_retention_days)
            .field("retention_batch_size", &self.retention_batch_size)
            .field("retention_interval_ms", &self.retention_interval_ms)
            .field("retention_budget_ms", &self.retention_budget_ms)
            .field("enrollment_interval_ms", &self.enrollment_interval_ms)
            .finish()
    }
}

impl std::fmt::Debug for EnvOverrides {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EnvOverrides")
            .field("port", &self.port)
            .field("base_url", &self.base_url)
            .field("trust_proxy", &self.trust_proxy)
            .field("database_url", &redacted_option(&self.database_url))
            .field("encryption_key", &redacted_option(&self.encryption_key))
            .field("secret_key", &redacted_option(&self.secret_key))
            .field("data_dir", &self.data_dir)
            .field("dashboard_dir", &self.dashboard_dir)
            .field("node_env", &self.node_env)
            .field("resend_api_key", &redacted_option(&self.resend_api_key))
            .field("smtp_url", &redacted_option(&self.smtp_url))
            .field("email_from", &self.email_from)
            .field("db_max_connections", &self.db_max_connections)
            .field("db_acquire_timeout_ms", &self.db_acquire_timeout_ms)
            .field("request_timeout_ms", &self.request_timeout_ms)
            .field("drain_timeout_ms", &self.drain_timeout_ms)
            .field("allow_private_networks", &self.allow_private_networks)
            .field("webhook_retention_days", &self.webhook_retention_days)
            .field("audit_retention_days", &self.audit_retention_days)
            .field("retention_batch_size", &self.retention_batch_size)
            .field("retention_interval_ms", &self.retention_interval_ms)
            .field("retention_budget_ms", &self.retention_budget_ms)
            .field("enrollment_interval_ms", &self.enrollment_interval_ms)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_output_never_contains_secrets() {
        let overrides = EnvOverrides {
            database_url: Some("postgres://u:db-secret-pw@h/d".into()),
            encryption_key: Some("encryption-secret-value".into()),
            secret_key: Some("secret-key-value".into()),
            smtp_url: Some("smtp://u:smtp-secret@h".into()),
            resend_api_key: Some("re_resend_secret".into()),
            port: Some(1234),
            ..Default::default()
        };
        let text = format!("{overrides:?}");
        for secret in [
            "db-secret-pw",
            "encryption-secret-value",
            "secret-key-value",
            "smtp-secret",
            "re_resend_secret",
        ] {
            assert!(!text.contains(secret), "{secret} leaked: {text}");
        }
        assert!(text.contains("1234") && text.contains("<redacted>"));
    }
}
