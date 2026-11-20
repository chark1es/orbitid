//! CLI: start/migrate, key printing, owner grants, logical export/import/copy
//! and the container readiness probe.

use std::net::SocketAddr;

use clap::{Parser, Subcommand};
use orbitid_core::state::create_context;
use orbitid_core::{EnvOverrides, OrbitError};
use tracing_subscriber::EnvFilter;

const USAGE: &str = "Usage: orbitid [command]

  start              Run migrations and start the server (default)
  migrate            Run migrations and exit
  keys               Print the publishable and secret keys and exit
  owner <account>    Give an existing account the Owner role, so it can open
                     the dashboard (a user id or a verified email address)
  export [--out f]   Write every table to JSON Lines (default: stdout)
  import [--in f]    Load JSON Lines into the configured database
                     [--truncate --yes]
  copy --from <url> --to <url> [--truncate --yes]
                     Copy one Postgres database into another in one step
  import-uploads --from <dir>
                     Import avatars/logos from a TypeScript data directory
  healthcheck        Probe http://127.0.0.1:$PORT/ready (exit 0 ready, 1 otherwise)
  help               Show this message

Configuration is read from environment variables (see .env.example).
Only Postgres is supported: SQLite and PGlite sources are no longer accepted by
export/import/copy.";

#[derive(Parser)]
#[command(
    name = "orbitid",
    disable_help_flag = true,
    disable_help_subcommand = true
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Run migrations and start the server (default)
    Start,
    /// Run migrations and exit
    Migrate,
    /// Print the publishable and secret keys and exit
    Keys,
    /// Give an existing account the Owner role (user id or verified email)
    Owner { account: String },
    /// Write every table to JSON Lines (default: stdout)
    Export {
        #[arg(long, default_value = "-")]
        out: String,
    },
    /// Load JSON Lines into the configured database
    Import {
        #[arg(long = "in", default_value = "-")]
        input: String,
        #[arg(long)]
        truncate: bool,
        #[arg(long)]
        yes: bool,
    },
    /// Copy one Postgres database into another in one step
    ///
    /// Each side is a URL (`--from`/`--to`; percent-encode special characters in
    /// the password) or split settings in the environment
    /// (`ORBITID_COPY_FROM_HOST|PORT|USER|PASSWORD|NAME`, likewise `..._TO_...`),
    /// which keeps the password out of the process list.
    Copy {
        #[arg(long)]
        from: Option<String>,
        #[arg(long)]
        to: Option<String>,
        #[arg(long)]
        truncate: bool,
        #[arg(long)]
        yes: bool,
    },
    /// Import avatars/logos from a TypeScript data directory
    ImportUploads {
        #[arg(long)]
        from: std::path::PathBuf,
    },
    /// Probe the local instance's readiness endpoint
    Healthcheck,
    /// Show the usage message
    Help,
}

fn init_tracing() {
    // Logs go to stderr so `export --out -` and the import summary on stdout stay
    // machine-readable (the TS CLI writes progress to stderr for the same reason).
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,sqlx::postgres::notice=warn"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .try_init();
}

fn startup_error(error: OrbitError) -> i32 {
    eprintln!("{}", error.message);
    1
}

/// Runs the CLI and returns the process exit code.
pub async fn run() -> i32 {
    let raw: Vec<String> = std::env::args().collect();
    let first = raw.get(1).map(String::as_str).unwrap_or("start");
    if matches!(first, "help" | "--help" | "-h") {
        println!("{USAGE}");
        return 0;
    }
    if !matches!(
        first,
        "start"
            | "migrate"
            | "keys"
            | "owner"
            | "export"
            | "import"
            | "copy"
            | "import-uploads"
            | "healthcheck"
    ) {
        eprintln!("Unknown command: {first}\n\n{USAGE}");
        return 1;
    }
    let cli = Cli::parse_from(raw);
    match cli.command.unwrap_or(Command::Start) {
        Command::Help => {
            println!("{USAGE}");
            0
        }
        Command::Keys => {
            init_tracing();
            let state = match create_context(EnvOverrides::default()).await {
                Ok(state) => state,
                Err(error) => return startup_error(error),
            };
            println!("Publishable key : {}", state.publishable_key);
            println!("Secret key      : {}", state.env.secret_key);
            0
        }
        Command::Owner { account } => {
            init_tracing();
            let state = match create_context(EnvOverrides::default()).await {
                Ok(state) => state,
                Err(error) => return startup_error(error),
            };
            owner(&state, &account).await
        }
        Command::Export { out } => {
            init_tracing();
            let progress = |message: &str| eprintln!("{message}");
            match crate::transfer::export_database_from(EnvOverrides::default(), &out, &progress)
                .await
            {
                Ok((result, label)) => {
                    if out != "-" {
                        println!(
                            "Exported {} rows in {} tables from {} to {}",
                            result.rows,
                            result.tables.len(),
                            label,
                            out
                        );
                    }
                    0
                }
                Err(message) => {
                    eprintln!("{message}");
                    1
                }
            }
        }
        Command::Import {
            input,
            truncate,
            yes,
        } => {
            init_tracing();
            let state = match create_context(EnvOverrides::default()).await {
                Ok(state) => state,
                Err(error) => return startup_error(error),
            };
            let progress = |message: &str| eprintln!("{message}");
            match crate::transfer::import_database(&state, &input, truncate, yes, &progress).await {
                Ok(result) => {
                    // Machine-readable summary last, so `copy` can print a per-table comparison from it.
                    println!(
                        "{}",
                        serde_json::json!({
                            "orbitid_import": 1,
                            "ok": result.ok,
                            "counts": result.counts,
                        })
                    );
                    0
                }
                Err(message) => {
                    eprintln!("{message}");
                    1
                }
            }
        }
        Command::Copy {
            from,
            to,
            truncate,
            yes,
        } => {
            init_tracing();
            if truncate && !yes {
                eprintln!(
                    "--truncate deletes everything in the target database. Pass --yes to confirm."
                );
                return 1;
            }
            let env = |name: &str| std::env::var(name).ok();
            let resolved = crate::transfer::resolve_endpoint(
                from.as_deref(),
                &crate::transfer::FROM_VARS,
                "from",
                &env,
            )
            .and_then(|from| {
                crate::transfer::resolve_endpoint(
                    to.as_deref(),
                    &crate::transfer::TO_VARS,
                    "to",
                    &env,
                )
                .map(|to| (from, to))
            });
            let (from, to) = match resolved {
                Ok(pair) => pair,
                Err(message) => {
                    eprintln!("{message}");
                    return 1;
                }
            };
            let progress = |message: &str| println!("{message}");
            match crate::transfer::copy_database(&from, &to, truncate, yes, &progress).await {
                Ok(()) => 0,
                Err(message) => {
                    eprintln!("{message}");
                    1
                }
            }
        }
        Command::ImportUploads { from } => {
            init_tracing();
            let state = match create_context(EnvOverrides::default()).await {
                Ok(state) => state,
                Err(error) => return startup_error(error),
            };
            match crate::import_uploads::import_legacy_uploads(&state, &from).await {
                Ok(summary) => {
                    println!(
                        "Imported {} uploads from {} ({} skipped)",
                        summary.imported,
                        from.display(),
                        summary.skipped
                    );
                    0
                }
                Err(error) => {
                    eprintln!("{}", error.message);
                    1
                }
            }
        }
        Command::Healthcheck => healthcheck().await,
        Command::Migrate => {
            init_tracing();
            let state = match create_context(EnvOverrides::default()).await {
                Ok(state) => state,
                Err(error) => return startup_error(error),
            };
            println!("Migrations applied to {}", state.env.database.label());
            0
        }
        Command::Start => {
            init_tracing();
            let state = match create_context(EnvOverrides::default()).await {
                Ok(state) => state,
                Err(error) => return startup_error(error),
            };
            if let Err(error) = start(state).await {
                return startup_error(error);
            }
            0
        }
    }
}

/// `orbitid owner <account>`: the server-side way into the dashboard. The
/// secret key does not open it, so an instance whose accounts predate owners
/// (or whose owners lost access) gets its first owner here.
async fn owner(state: &orbitid_core::AppState, account: &str) -> i32 {
    // Seeds the Owner role on a database this version has not started against yet.
    if let Err(error) = orbitid_identity::install_without_workers(state).await {
        return startup_error(error);
    }
    match orbitid_identity::console::grant_owner(state, account).await {
        Ok(orbitid_identity::console::OwnerGrant::Granted(user)) => {
            orbitid_platform::audit::audit(
                state,
                orbitid_platform::audit::AuditInput::new("instance.owner_granted")
                    .actor("cli")
                    .target_type("user")
                    .target_id(user.id.clone()),
            )
            .await;
            println!(
                "{} is now an owner. Sign in to the dashboard at {} with that account.",
                user.id, state.env.base_url
            );
            0
        }
        Ok(orbitid_identity::console::OwnerGrant::AlreadyOwner(user)) => {
            println!("{} is already an owner; nothing changed.", user.id);
            0
        }
        Err(error) => startup_error(error),
    }
}

/// `orbitid healthcheck`: a dependency-free readiness probe for container
/// runtimes. It performs one HTTP/1.1 request to `/ready` on the local port and
/// exits 0 only for a 200 response within a short deadline.
async fn healthcheck() -> i32 {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let port = std::env::var("PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(4000);
    let address = format!("127.0.0.1:{port}");
    let deadline = std::time::Duration::from_secs(2);
    let Ok(Ok(mut stream)) =
        tokio::time::timeout(deadline, tokio::net::TcpStream::connect(&address)).await
    else {
        return 1;
    };
    let request = format!("GET /ready HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n");
    if tokio::time::timeout(deadline, stream.write_all(request.as_bytes()))
        .await
        .is_err()
    {
        return 1;
    }
    let mut response = Vec::with_capacity(256);
    match tokio::time::timeout(deadline, stream.read_to_end(&mut response)).await {
        Ok(Ok(_)) => {}
        _ => return 1,
    }
    let head = String::from_utf8_lossy(&response);
    let status = head.lines().next().unwrap_or_default();
    if status.contains(" 200 ") {
        0
    } else {
        1
    }
}

/// The startup warning for a trusted-proxy deployment whose public URL is plain
/// http on a non-local host.
///
/// `X-Forwarded-Proto` decides the `Secure` attribute of the client-session
/// cookie, but the dashboard operator-session cookie derives it from
/// `ORBITID_BASE_URL` only. A TLS-terminating proxy must therefore also set an
/// `https://` base URL, or the operator cookie travels without `Secure`.
pub fn trust_proxy_warning(base_url: &str, trust_proxy: usize) -> Option<String> {
    if trust_proxy == 0
        || !base_url.starts_with("http://")
        || orbitid_core::config::is_local_base_url(base_url)
    {
        return None;
    }
    Some(format!(
        "ORBITID_TRUST_PROXY={trust_proxy} is set but ORBITID_BASE_URL is {base_url} (plain http on a non-local host). \
         The dashboard operator-session cookie derives its Secure attribute from ORBITID_BASE_URL only, so it will not be marked Secure. \
         Set ORBITID_BASE_URL to the public https:// URL when TLS terminates at the proxy."
    ))
}

/// Binds the port, installs the identity layer and workers, prints the startup
/// banner and serves until SIGINT/SIGTERM.
///
/// Shutdown order: stop accepting connections, give in-flight requests
/// `ORBITID_DRAIN_TIMEOUT_MS` to finish, stop the workers, return. Every worker
/// is safe to run on all replicas (rows are claimed with `SKIP LOCKED` or an
/// advisory lock), so a rolling deploy never double-delivers.
pub async fn start(state: orbitid_core::AppState) -> Result<(), OrbitError> {
    if let Some(warning) = trust_proxy_warning(&state.env.base_url, state.env.trust_proxy) {
        tracing::warn!("{warning}");
    }
    let install = orbitid_identity::install(&state).await?;
    let webhook_worker = orbitid_platform::webhooks::WebhookWorker::start(state.clone());
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", state.env.port))
        .await
        .map_err(|error| {
            OrbitError::internal(format!(
                "Could not listen on port {}: {error}",
                state.env.port
            ))
        })?;
    let dashboard = if crate::dashboard::dashboard_available(&state) {
        state.env.base_url.clone()
    } else {
        "not built (run: bun run --filter @orbitid/dashboard build)".to_string()
    };
    println!("\n  OrbitID is running at {}", state.env.base_url);
    println!("  Dashboard       : {dashboard}");
    println!("  Publishable key : {}", state.publishable_key);
    // Never printed by `start`: startup output is captured by process managers,
    // container logs and terminal scrollback. `orbitid keys` writes it on purpose.
    println!("  Secret key      : hidden. Print it with: orbitid keys");
    println!(
        "  JWKS            : {}/.well-known/jwks.json",
        state.env.base_url
    );
    println!("  Database        : {}", state.env.database.label());
    for line in orbitid_platform::mail::email_startup_warnings(&state) {
        println!("{line}");
    }
    println!();

    let app = crate::build_app(state.clone());
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        let _ = stopped.await;
    });
    let task = tokio::spawn(async move { server.await });

    shutdown_signal().await;
    tracing::info!("shutdown signal received; draining in-flight requests");
    let _ = stop.send(());
    let drain = std::time::Duration::from_millis(state.env.drain_timeout_ms);
    match tokio::time::timeout(drain, task).await {
        Ok(Ok(Ok(()))) => {}
        Ok(Ok(Err(error))) => {
            webhook_worker.shutdown().await;
            install.shutdown();
            return Err(OrbitError::internal(format!("Server stopped: {error}")));
        }
        Ok(Err(join_error)) => {
            webhook_worker.shutdown().await;
            install.shutdown();
            return Err(OrbitError::internal(format!(
                "Server task failed: {join_error}"
            )));
        }
        Err(_) => {
            tracing::warn!(
                "drain deadline ({} ms) exceeded; exiting with requests still in flight",
                state.env.drain_timeout_ms
            );
        }
    }
    webhook_worker.shutdown().await;
    install.shutdown();
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = crate::transfer::ctrl_c_or_pending();
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(error) => {
                tracing::warn!("could not install the SIGTERM handler: {error}");
                std::future::pending::<()>().await
            }
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
