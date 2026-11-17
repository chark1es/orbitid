//! Database connection settings.
//!
//! Two ways to configure the connection, resolved once at startup:
//!
//! 1. a URL (`ORBITID_DATABASE_URL`, falling back to `DATABASE_URL`): it wins
//!    whenever it is set;
//! 2. separate parts, so no value ever needs URL-encoding:
//!    `ORBITID_DATABASE_HOST`, `_PORT`, `_USER`, `_PASSWORD`, `_NAME`, each
//!    falling back to the libpq variable `PGHOST`, `PGPORT`, `PGUSER`,
//!    `PGPASSWORD`, `PGDATABASE`.
//!
//! Either form is turned into `sqlx` [`PgConnectOptions`]; the parts form is
//! built with the option builders, so a password such as `a/b+c=d@e:f%g h` is
//! passed to the server byte-for-byte.

use sqlx::postgres::PgConnectOptions;
use std::fmt;
use std::str::FromStr;

use super::ConfigError;

/// Resolved database connection options plus a password-free label that is safe
/// to print and log.
#[derive(Clone)]
pub struct DatabaseConfig {
    options: PgConnectOptions,
    label: String,
}

impl DatabaseConfig {
    /// Parses a `postgres://` / `postgresql://` URL (percent-decoded by sqlx).
    pub fn from_url(url: &str) -> Result<Self, ConfigError> {
        if !(url.starts_with("postgres://") || url.starts_with("postgresql://")) {
            return Err(ConfigError::new(
                "ORBITID_DATABASE_URL must be a postgres:// or postgresql:// URL. SQLite and PGlite are no longer supported by this server.",
            ));
        }
        let options = PgConnectOptions::from_str(url).map_err(|error| {
            ConfigError::new(format!(
                "ORBITID_DATABASE_URL is not a valid Postgres URL ({error}). A password containing / + = @ : % or spaces must be percent-encoded in a URL; prefer ORBITID_DATABASE_HOST/PORT/USER/PASSWORD/NAME, which need no encoding."
            ))
        })?;
        Ok(Self {
            options,
            label: redact_url(url),
        })
    }

    /// Builds the options from separate parts. The password is optional.
    pub fn from_parts(
        host: &str,
        port: u16,
        user: &str,
        password: Option<&str>,
        name: &str,
    ) -> Self {
        let mut options = PgConnectOptions::new_without_pgpass()
            .host(host)
            .port(port)
            .username(user)
            .database(name);
        if let Some(password) = password {
            options = options.password(password);
        }
        Self {
            options,
            label: format!("postgres://{user}@{host}:{port}/{name}"),
        }
    }

    /// The connection options (cloned; they hold the password).
    pub fn connect_options(&self) -> PgConnectOptions {
        self.options.clone()
    }

    /// `postgres://user@host:port/name`, never containing the password.
    pub fn label(&self) -> &str {
        &self.label
    }
}

impl fmt::Debug for DatabaseConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DatabaseConfig")
            .field("target", &self.label)
            .finish()
    }
}

/// `scheme://user@host:port/db`: no password and no query string.
fn redact_url(raw: &str) -> String {
    match url::Url::parse(raw) {
        Ok(url) => {
            let mut out = format!("{}://", url.scheme());
            if !url.username().is_empty() {
                out.push_str(url.username());
                out.push('@');
            }
            if let Some(host) = url.host_str() {
                out.push_str(host);
            }
            if let Some(port) = url.port() {
                out.push(':');
                out.push_str(&port.to_string());
            }
            out.push_str(url.path());
            out
        }
        Err(_) => "postgres://<unparsable>".to_string(),
    }
}

/// First non-empty of the given variables.
fn first(lookup: &dyn Fn(&str) -> Option<String>, names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| lookup(name).filter(|value| !value.is_empty()))
}

/// Resolves the database configuration. `override_url` (programmatic override)
/// and the URL variables win over the parts.
pub fn resolve_database(
    override_url: Option<String>,
    lookup: &dyn Fn(&str) -> Option<String>,
) -> Result<DatabaseConfig, ConfigError> {
    let url = override_url
        .filter(|value| !value.is_empty())
        .or_else(|| first(lookup, &["ORBITID_DATABASE_URL", "DATABASE_URL"]));
    if let Some(url) = url {
        return DatabaseConfig::from_url(&url);
    }
    let Some(host) = first(lookup, &["ORBITID_DATABASE_HOST", "PGHOST"]) else {
        return Err(ConfigError::new(
            "The database is not configured. The Rust server only supports Postgres: set ORBITID_DATABASE_URL=postgres://user:pass@host:5432/orbitid, or the separate ORBITID_DATABASE_HOST, ORBITID_DATABASE_PORT, ORBITID_DATABASE_USER, ORBITID_DATABASE_PASSWORD and ORBITID_DATABASE_NAME (no URL-encoding needed).",
        ));
    };
    let port = match first(lookup, &["ORBITID_DATABASE_PORT", "PGPORT"]) {
        None => 5432,
        Some(value) => value.parse::<u16>().map_err(|_| {
            ConfigError::new("ORBITID_DATABASE_PORT must be an integer between 1 and 65535.")
        })?,
    };
    let user =
        first(lookup, &["ORBITID_DATABASE_USER", "PGUSER"]).unwrap_or_else(|| "postgres".into());
    let name =
        first(lookup, &["ORBITID_DATABASE_NAME", "PGDATABASE"]).unwrap_or_else(|| user.clone());
    let password = first(lookup, &["ORBITID_DATABASE_PASSWORD", "PGPASSWORD"]);
    Ok(DatabaseConfig::from_parts(
        &host,
        port,
        &user,
        password.as_deref(),
        &name,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn lookup(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect();
        move |name| map.get(name).cloned()
    }

    #[test]
    fn the_url_wins_over_the_parts() {
        let env = lookup(&[
            ("ORBITID_DATABASE_URL", "postgres://u:p@urlhost:6543/urldb"),
            ("ORBITID_DATABASE_HOST", "parthost"),
            ("ORBITID_DATABASE_NAME", "partdb"),
        ]);
        let config = resolve_database(None, &env).expect("resolves");
        let options = config.connect_options();
        assert_eq!(options.get_host(), "urlhost");
        assert_eq!(options.get_port(), 6543);
        assert_eq!(options.get_database(), Some("urldb"));
        assert_eq!(config.label(), "postgres://u@urlhost:6543/urldb");
        // The programmatic override beats the environment URL.
        let overridden =
            resolve_database(Some("postgres://o:p@oh:1/od".into()), &env).expect("override");
        assert_eq!(overridden.connect_options().get_host(), "oh");
    }

    #[test]
    fn parts_carry_a_password_with_every_url_hostile_character() {
        let hostile = "a/b+c=d@e:f%g h?i#j";
        let env = lookup(&[
            ("ORBITID_DATABASE_HOST", "db.internal"),
            ("ORBITID_DATABASE_PORT", "5433"),
            ("ORBITID_DATABASE_USER", "orbit id"),
            ("ORBITID_DATABASE_PASSWORD", hostile),
            ("ORBITID_DATABASE_NAME", "orbit"),
        ]);
        let config = resolve_database(None, &env).expect("resolves");
        let options = config.connect_options();
        assert_eq!(options.get_host(), "db.internal");
        assert_eq!(options.get_port(), 5433);
        assert_eq!(options.get_username(), "orbit id");
        assert_eq!(options.get_database(), Some("orbit"));
        // `PgConnectOptions` has no password getter and redacts it in Debug;
        // `tests/database_parts.rs` proves the password against a live server.
        assert!(!config.label().contains(hostile), "{}", config.label());
        assert!(!format!("{config:?}").contains("c=d"));
    }

    #[test]
    fn the_standard_libpq_variables_are_the_fallback() {
        let env = lookup(&[
            ("PGHOST", "pg.internal"),
            ("PGPORT", "5440"),
            ("PGUSER", "pguser"),
            ("PGPASSWORD", "p/w+="),
            ("PGDATABASE", "pgdb"),
            ("ORBITID_DATABASE_NAME", "preferred"),
        ]);
        let options = resolve_database(None, &env)
            .expect("resolves")
            .connect_options();
        assert_eq!(options.get_host(), "pg.internal");
        assert_eq!(options.get_port(), 5440);
        assert_eq!(options.get_username(), "pguser");
        assert_eq!(options.get_database(), Some("preferred"));
    }

    #[test]
    fn nothing_configured_is_an_actionable_error() {
        let error = resolve_database(None, &lookup(&[]))
            .unwrap_err()
            .to_string();
        assert!(error.contains("ORBITID_DATABASE_HOST"), "{error}");
        let error = resolve_database(
            None,
            &lookup(&[
                ("ORBITID_DATABASE_HOST", "h"),
                ("ORBITID_DATABASE_PORT", "x"),
            ]),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("ORBITID_DATABASE_PORT"), "{error}");
    }

    #[test]
    fn a_url_must_be_postgres() {
        let error = resolve_database(Some("sqlite:./x.db".into()), &lookup(&[]))
            .unwrap_err()
            .to_string();
        assert!(error.contains("postgres://"), "{error}");
    }
}
