//! Database endpoints for `orbitid copy`: a URL (`--from`/`--to`) or split
//! settings from the environment, so a password never has to be percent-encoded
//! into a URL or appear in the process list.

use url::Url;

/// The environment variable names of one side of a copy.
pub struct EndpointVars {
    pub host: &'static str,
    pub port: &'static str,
    pub user: &'static str,
    pub password: &'static str,
    pub name: &'static str,
}

pub const FROM_VARS: EndpointVars = EndpointVars {
    host: "ORBITID_COPY_FROM_HOST",
    port: "ORBITID_COPY_FROM_PORT",
    user: "ORBITID_COPY_FROM_USER",
    password: "ORBITID_COPY_FROM_PASSWORD",
    name: "ORBITID_COPY_FROM_NAME",
};

pub const TO_VARS: EndpointVars = EndpointVars {
    host: "ORBITID_COPY_TO_HOST",
    port: "ORBITID_COPY_TO_PORT",
    user: "ORBITID_COPY_TO_USER",
    password: "ORBITID_COPY_TO_PASSWORD",
    name: "ORBITID_COPY_TO_NAME",
};

/// Resolves one side: an explicit URL wins; otherwise the split variables
/// (`HOST` and `NAME` required, `PORT` defaults to 5432, `USER` and `PASSWORD`
/// optional) are assembled with proper percent-encoding. `get` reads the
/// environment (tests inject a map).
pub fn resolve_endpoint(
    url: Option<&str>,
    vars: &EndpointVars,
    side: &str,
    get: &dyn Fn(&str) -> Option<String>,
) -> Result<String, String> {
    if let Some(url) = url.filter(|value| !value.is_empty()) {
        return Ok(url.to_string());
    }
    let value = |name: &str| get(name).filter(|value| !value.is_empty());
    let (Some(host), Some(name)) = (value(vars.host), value(vars.name)) else {
        return Err(format!(
            "Pass --{side} <url> or set {} and {} (plus optionally {}, {} and {}).",
            vars.host, vars.name, vars.port, vars.user, vars.password
        ));
    };
    let port = match value(vars.port) {
        Some(raw) => raw
            .parse::<u16>()
            .map_err(|_| format!("{} must be a port number.", vars.port))?,
        None => 5432,
    };
    let mut url = Url::parse("postgres://placeholder/")
        .map_err(|error| format!("could not build the database URL: {error}"))?;
    url.set_host(Some(&host))
        .map_err(|_| format!("{} is not a valid host name.", vars.host))?;
    url.set_port(Some(port))
        .map_err(|_| "could not set the port".to_string())?;
    if let Some(user) = value(vars.user) {
        url.set_username(&user)
            .map_err(|_| format!("{} cannot be used in a URL.", vars.user))?;
        if let Some(password) = value(vars.password) {
            url.set_password(Some(&password))
                .map_err(|_| format!("{} cannot be used in a URL.", vars.password))?;
        }
    }
    url.set_path(&format!("/{name}"));
    Ok(url.to_string())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn a_password_with_url_metacharacters_round_trips() {
        let secret = "p/a+s=s@w:rd";
        let map = env(&[
            ("ORBITID_COPY_FROM_HOST", "db.internal"),
            ("ORBITID_COPY_FROM_PORT", "6543"),
            ("ORBITID_COPY_FROM_USER", "orbit id"),
            ("ORBITID_COPY_FROM_PASSWORD", secret),
            ("ORBITID_COPY_FROM_NAME", "orbitid"),
        ]);
        let resolved =
            resolve_endpoint(None, &FROM_VARS, "from", &|key| map.get(key).cloned()).unwrap();
        let parsed = Url::parse(&resolved).unwrap();
        assert_eq!(parsed.host_str(), Some("db.internal"));
        assert_eq!(parsed.port(), Some(6543));
        assert_eq!(parsed.path(), "/orbitid");
        let decoded = percent_encoding::percent_decode_str(parsed.password().unwrap())
            .decode_utf8()
            .unwrap();
        assert_eq!(decoded, secret);
        assert!(!resolved.contains(secret), "the raw secret is encoded");
        let user = percent_encoding::percent_decode_str(parsed.username())
            .decode_utf8()
            .unwrap();
        assert_eq!(user, "orbit id");
    }

    #[test]
    fn a_url_wins_and_missing_settings_are_explained() {
        let map = env(&[]);
        let get = |key: &str| map.get(key).cloned();
        assert_eq!(
            resolve_endpoint(Some("postgres://u:p@h/d"), &TO_VARS, "to", &get).unwrap(),
            "postgres://u:p@h/d"
        );
        let error = resolve_endpoint(None, &TO_VARS, "to", &get).unwrap_err();
        assert!(error.contains("ORBITID_COPY_TO_HOST"), "{error}");
        let defaulted = env(&[
            ("ORBITID_COPY_TO_HOST", "localhost"),
            ("ORBITID_COPY_TO_NAME", "x"),
        ]);
        assert_eq!(
            resolve_endpoint(None, &TO_VARS, "to", &|key| defaulted.get(key).cloned()).unwrap(),
            "postgres://localhost:5432/x"
        );
    }
}
