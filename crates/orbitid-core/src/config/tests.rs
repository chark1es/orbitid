//! `load_env` validation tests (split out to keep `config.rs` focused).

use super::*;

fn base(overrides: EnvOverrides) -> Result<Env, ConfigError> {
    load_env(overrides)
}

#[test]
fn requires_postgres_url() {
    let err = base(EnvOverrides {
        database_url: Some("sqlite:./x.db".into()),
        encryption_key: Some("k".repeat(40)),
        ..Default::default()
    })
    .unwrap_err();
    assert!(err.to_string().contains("postgres://"));
}

#[test]
fn requires_encryption_key_for_postgres() {
    let err = base(EnvOverrides {
        database_url: Some("postgres://u:p@localhost:5432/orbit".into()),
        ..Default::default()
    })
    .unwrap_err();
    assert!(err.to_string().contains("ORBITID_ENCRYPTION_KEY"));

    let err = base(EnvOverrides {
        database_url: Some("postgres://u:p@localhost:5432/orbit".into()),
        base_url: Some("https://auth.example.com".into()),
        ..Default::default()
    })
    .unwrap_err();
    assert!(err.to_string().contains("ORBITID_ENCRYPTION_KEY"));
}

#[test]
fn rejects_short_encryption_key() {
    let err = base(EnvOverrides {
        database_url: Some("postgres://u:p@localhost:5432/orbit".into()),
        encryption_key: Some("short".into()),
        ..Default::default()
    })
    .unwrap_err();
    assert!(err.to_string().contains("at least 32"));
}

#[test]
fn production_requires_key_and_checks_secret() {
    let err = base(EnvOverrides {
        database_url: Some("postgres://u:p@localhost:5432/orbit".into()),
        node_env: Some("production".into()),
        ..Default::default()
    })
    .unwrap_err();
    assert!(err.to_string().contains("required in production"));

    let err = base(EnvOverrides {
        database_url: Some("postgres://u:p@localhost:5432/orbit".into()),
        node_env: Some("production".into()),
        encryption_key: Some("k".repeat(40)),
        secret_key: Some("short".into()),
        ..Default::default()
    })
    .unwrap_err();
    assert!(err.to_string().contains("at least 32 random characters"));
}

#[test]
fn strips_one_trailing_slash_and_trust_proxy() {
    let env = base(EnvOverrides {
        database_url: Some("postgres://u:p@localhost:5432/orbit".into()),
        encryption_key: Some("k".repeat(40)),
        base_url: Some("http://localhost:4000/".into()),
        trust_proxy: Some(2),
        ..Default::default()
    })
    .unwrap();
    assert_eq!(env.base_url, "http://localhost:4000");
    assert_eq!(env.trust_proxy, 2);
    assert!(env.base_url_explicit);
}

#[test]
fn retention_settings_default_and_accept_overrides() {
    let defaults = base(EnvOverrides {
        database_url: Some("postgres://u:p@localhost:5432/orbit".into()),
        encryption_key: Some("k".repeat(40)),
        ..Default::default()
    })
    .unwrap();
    assert_eq!(defaults.webhook_retention_days, 30);
    assert_eq!(defaults.audit_retention_days, 0);

    let custom = base(EnvOverrides {
        database_url: Some("postgres://u:p@localhost:5432/orbit".into()),
        encryption_key: Some("k".repeat(40)),
        webhook_retention_days: Some(7),
        audit_retention_days: Some(90),
        ..Default::default()
    })
    .unwrap();
    assert_eq!(custom.webhook_retention_days, 7);
    assert_eq!(custom.audit_retention_days, 90);
}

#[test]
fn update_check_defaults_on_and_refuses_unclear_values() {
    assert!(parse_update_check(None).unwrap());
    assert!(parse_update_check(Some("")).unwrap());
    for on in ["true", "TRUE", "1", "yes", "on", " true "] {
        assert!(parse_update_check(Some(on)).unwrap(), "{on}");
    }
    for off in ["false", "False", "0", "no", "off"] {
        assert!(!parse_update_check(Some(off)).unwrap(), "{off}");
    }
    let err = parse_update_check(Some("flase")).unwrap_err();
    assert!(err.to_string().contains("ORBITID_UPDATE_CHECK"));

    let disabled = base(EnvOverrides {
        database_url: Some("postgres://u:p@localhost:5432/orbit".into()),
        encryption_key: Some("k".repeat(40)),
        update_check: Some(false),
        ..Default::default()
    })
    .unwrap();
    assert!(!disabled.update_check);
}

#[test]
fn database_path_is_refused_instead_of_ignored() {
    assert!(refuse_database_path(None).is_ok());
    assert!(refuse_database_path(Some(String::new())).is_ok());
    let err = refuse_database_path(Some("./orbitid.db".into())).unwrap_err();
    assert!(err.to_string().contains("ORBITID_DATABASE_PATH"));
    assert!(err.to_string().contains("Postgres-only"));
    assert!(err.to_string().contains("./orbitid.db"));
}

#[test]
fn local_base_urls_are_recognised_for_the_trust_proxy_warning() {
    for local in [
        "http://localhost:4000",
        "http://127.0.0.1:4000",
        "https://localhost",
        "http://[::1]:4000",
    ] {
        assert!(is_local_base_url(local), "{local} is local");
    }
    for remote in [
        "http://auth.example.com",
        "https://auth.example.com",
        "http://localhost.evil.example",
        "http://192.168.1.10:4000",
    ] {
        assert!(!is_local_base_url(remote), "{remote} is not local");
    }
}
