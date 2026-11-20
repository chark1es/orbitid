//! The `orbitid` binary's commands and output text (the retired TypeScript server).

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::process::Command;

use orbitid_core::testing::test_state;

fn binary() -> &'static str {
    env!("CARGO_BIN_EXE_orbitid")
}

fn run(args: &[&str]) -> std::process::Output {
    Command::new(binary()).args(args).output().unwrap()
}

#[test]
fn help_prints_the_usage_message() {
    for args in [&["help"][..], &["--help"][..], &["-h"][..]] {
        let output = run(args);
        assert!(output.status.success());
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(stdout.contains("Usage: orbitid [command]"));
        assert!(stdout.contains("start              Run migrations and start the server (default)"));
        assert!(
            stdout.contains("keys               Print the publishable and secret keys and exit")
        );
        assert!(stdout.contains("owner <account>    Give an existing account the Owner role"));
        assert!(
            stdout.contains("Only Postgres is supported"),
            "the help documents that SQLite/PGlite transfer sources are dropped"
        );
    }
}

#[test]
fn unknown_commands_fail_with_usage() {
    let output = run(&["definitely-not-a-command"]);
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.starts_with("Unknown command: definitely-not-a-command"));
    assert!(stderr.contains("Usage: orbitid [command]"));
}

#[tokio::test]
async fn keys_and_migrate_use_the_configured_database() {
    let ctx = test_state().await;
    let data_dir = std::env::temp_dir().join(format!(
        "orbitid-cli-{}",
        orbitid_core::crypto::random_token(6)
    ));
    let configure = |command: &mut Command| {
        command
            .env_clear()
            .env("ORBITID_DATABASE_URL", &ctx.db.url)
            .env(
                "ORBITID_ENCRYPTION_KEY",
                "test-encryption-key-for-orbitid-0123456789",
            )
            .env("ORBITID_BASE_URL", "http://localhost:4000")
            .env("ORBITID_DATA_DIR", &data_dir)
            .env("NODE_ENV", "test");
    };

    let mut keys = Command::new(binary());
    keys.arg("keys");
    configure(&mut keys);
    let output = keys.output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("Publishable key : pk_test_"));
    assert!(stdout.contains("Secret key      : sk_test_"));

    let mut migrate = Command::new(binary());
    migrate.arg("migrate");
    configure(&mut migrate);
    let output = migrate.output().unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("Migrations applied to postgres://"));
    assert!(
        !stdout.contains("orbit:orbit@"),
        "database label must be password-free"
    );
}

/// `orbitid owner` is the server-side way into the dashboard: it gives an
/// existing account the Owner role, by verified email or user id.
#[tokio::test]
async fn owner_grants_the_owner_role_to_an_existing_account() {
    let app = orbitid_identity::testing::test_app_state().await;
    let user = orbitid_identity::testing::create_test_user(
        app.state(),
        "existing@example.com",
        "correct horse battery staple",
    )
    .await
    .unwrap();
    let data_dir = app.data_dir();
    let owner = |account: &str| {
        Command::new(binary())
            .args(["owner", account])
            .env_clear()
            .env("ORBITID_DATABASE_URL", &app.context.db.url)
            .env(
                "ORBITID_ENCRYPTION_KEY",
                "test-encryption-key-for-orbitid-0123456789",
            )
            .env("ORBITID_BASE_URL", "http://localhost:4000")
            .env("ORBITID_DATA_DIR", &data_dir)
            .env("NODE_ENV", "test")
            .output()
            .unwrap()
    };

    let missing = owner("nobody@example.com");
    assert!(!missing.status.success());
    assert!(String::from_utf8_lossy(&missing.stderr).contains("No account"));

    let granted = owner("Existing@Example.com");
    assert!(
        granted.status.success(),
        "{}",
        String::from_utf8_lossy(&granted.stderr)
    );
    assert!(String::from_utf8_lossy(&granted.stdout).contains("is now an owner"));
    let roles: Vec<String> =
        sqlx::query_scalar("SELECT role_key FROM user_roles WHERE user_id = $1")
            .bind(user.id())
            .fetch_all(&app.state().pool)
            .await
            .unwrap();
    assert_eq!(roles, vec!["app:sys_owner".to_string()]);

    let again = owner(user.id());
    assert!(again.status.success());
    assert!(String::from_utf8_lossy(&again.stdout).contains("already an owner"));
}

#[tokio::test]
async fn export_import_and_copy_use_the_json_lines_format() {
    let source = orbitid_core::testing::test_state().await;
    let target = orbitid_core::testing::EphemeralDb::create().await.unwrap();
    let data_dir = std::env::temp_dir().join(format!(
        "orbitid-cli-transfer-{}",
        orbitid_core::crypto::random_token(6)
    ));
    let file = std::env::temp_dir().join(format!(
        "orbitid-cli-export-{}.jsonl",
        orbitid_core::crypto::random_token(6)
    ));
    let configure = |command: &mut Command| {
        command
            .env_clear()
            .env("ORBITID_DATABASE_URL", &source.db.url)
            .env(
                "ORBITID_ENCRYPTION_KEY",
                "test-encryption-key-for-orbitid-0123456789",
            )
            .env("ORBITID_BASE_URL", "http://localhost:4000")
            .env("ORBITID_DATA_DIR", &data_dir)
            .env("NODE_ENV", "test");
    };

    let mut export = Command::new(binary());
    export.args(["export", "--out", file.to_str().unwrap()]);
    configure(&mut export);
    let output = export.output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("Exported "), "{stdout}");
    let text = std::fs::read_to_string(&file).unwrap();
    let header: serde_json::Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
    assert_eq!(header["orbitid_export"], 1);
    assert_eq!(header["dialect"], "postgres");

    let mut import = Command::new(binary());
    import.args(["import", "--in", file.to_str().unwrap()]);
    import
        .env_clear()
        .env("ORBITID_DATABASE_URL", &target.url)
        .env(
            "ORBITID_ENCRYPTION_KEY",
            "test-encryption-key-for-orbitid-0123456789",
        )
        .env("ORBITID_BASE_URL", "http://localhost:4000")
        .env("ORBITID_DATA_DIR", &data_dir)
        .env("NODE_ENV", "test");
    let output = import.output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let summary: serde_json::Value = serde_json::from_str(stdout.trim()).unwrap();
    assert_eq!(summary["orbitid_import"], 1);
    assert_eq!(summary["ok"], true);

    // `copy` runs the same transfer between two databases.
    let copied = orbitid_core::testing::EphemeralDb::create().await.unwrap();
    let mut copy = Command::new(binary());
    copy.args(["copy", "--from", &source.db.url, "--to", &copied.url]);
    configure(&mut copy);
    let output = copy.output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("Imported users"), "{stdout}");
    assert!(
        !stdout.contains("orbit:orbit@") && !output_is_password_leak(&output),
        "copy output must not leak database credentials"
    );

    let _ = std::fs::remove_file(&file);
}

fn output_is_password_leak(output: &std::process::Output) -> bool {
    String::from_utf8_lossy(&output.stderr).contains("orbit:orbit@")
}

#[test]
fn trust_proxy_with_a_plain_http_public_url_warns_at_startup() {
    use orbitid_server::cli::trust_proxy_warning;

    let warning = trust_proxy_warning("http://auth.example.com", 1).expect("a warning");
    assert!(warning.contains("ORBITID_BASE_URL"));
    assert!(warning.contains("Secure"));
    assert!(
        trust_proxy_warning("http://localhost:4000", 1).is_none(),
        "a local plain-http instance is fine"
    );
    assert!(
        trust_proxy_warning("http://127.0.0.1:4000", 2).is_none(),
        "a local plain-http instance is fine"
    );
    assert!(
        trust_proxy_warning("https://auth.example.com", 1).is_none(),
        "an https base URL needs no warning"
    );
    assert!(
        trust_proxy_warning("http://auth.example.com", 0).is_none(),
        "without trusted proxies the header is ignored"
    );
}

#[test]
fn a_leftover_database_path_is_refused_with_a_clear_message() {
    let mut command = Command::new(binary());
    command
        .arg("migrate")
        .env_clear()
        .env("ORBITID_DATABASE_PATH", "./orbitid.db")
        .env(
            "ORBITID_DATABASE_URL",
            "postgres://u:p@localhost:5432/orbit",
        )
        .env("ORBITID_ENCRYPTION_KEY", "k".repeat(40))
        .env("ORBITID_BASE_URL", "http://localhost:4000")
        .env("NODE_ENV", "test");
    let output = command.output().unwrap();
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("ORBITID_DATABASE_PATH"), "{stderr}");
    assert!(stderr.contains("Postgres-only"), "{stderr}");
}

/// SIGINT while `copy` holds its staged export removes the directory and exits
/// with an error (the default disposition would skip `Drop` and leave it).
#[tokio::test]
async fn copy_interrupted_by_sigint_removes_its_staging_directory() {
    let source = orbitid_core::testing::test_state().await;
    let target = orbitid_core::testing::test_state().await;
    let tmp = std::env::temp_dir().join(format!(
        "orbitid-cli-sigint-{}",
        orbitid_core::crypto::random_token(6)
    ));
    std::fs::create_dir_all(&tmp).unwrap();
    // Hold the target's `users` table so the import blocks after the export is staged.
    let mut blocker = target.state.pool.begin().await.unwrap();
    sqlx::query("LOCK TABLE users IN ACCESS EXCLUSIVE MODE")
        .execute(&mut *blocker)
        .await
        .unwrap();

    let mut child = Command::new(binary())
        .args([
            "copy",
            "--from",
            &source.db.url,
            "--to",
            &target.db.url,
            "--truncate",
            "--yes",
        ])
        .env_clear()
        .env("TMPDIR", &tmp)
        .env(
            "ORBITID_ENCRYPTION_KEY",
            "test-encryption-key-for-orbitid-0123456789",
        )
        .env("ORBITID_BASE_URL", "http://localhost:4000")
        .env("ORBITID_DATA_DIR", tmp.join("data"))
        .env("NODE_ENV", "test")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();

    let staged = || {
        std::fs::read_dir(&tmp)
            .unwrap()
            .flatten()
            .find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("orbitid-transfer-")
            })
            .map(|entry| entry.path().join("export.jsonl"))
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    loop {
        let filled = staged()
            .and_then(|file| std::fs::metadata(file).ok())
            .is_some_and(|meta| meta.len() > 0);
        if filled {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline && child.try_wait().unwrap().is_none(),
            "the copy never staged its export"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }

    let signalled = Command::new("kill")
        .args(["-INT", &child.id().to_string()])
        .status()
        .unwrap();
    assert!(signalled.success());
    let output = child.wait_with_output().unwrap();
    drop(blocker);

    assert!(!output.status.success(), "an interrupted copy is an error");
    assert_eq!(
        output.status.code(),
        Some(1),
        "exits through the CLI, not by signal"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("copy interrupted"), "{stderr}");
    assert!(staged().is_none(), "the staging directory was removed");
    let _ = std::fs::remove_dir_all(&tmp);
}
