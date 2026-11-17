//! Pure e-mail address and SMTP URL validation, ported from
//! the retired TypeScript server.

use std::sync::OnceLock;

use crate::error::{error_codes, OrbitError};
use regex::Regex;

/// Default `From` used when neither settings nor the environment name one.
pub const DEFAULT_FROM: &str = "OrbitID <no-reply@localhost>";

fn compiled<'a>(cell: &'a OnceLock<Option<Regex>>, pattern: &str) -> Option<&'a Regex> {
    cell.get_or_init(|| Regex::new(pattern).ok()).as_ref()
}

fn matches(cell: &OnceLock<Option<Regex>>, pattern: &str, value: &str) -> bool {
    compiled(cell, pattern).is_some_and(|re| re.is_match(value))
}

/// Removes CR/LF (and other control characters) so a value cannot split a header.
pub fn header_safe(value: &str) -> String {
    let without_breaks: String = value
        .chars()
        .map(|c| {
            if c == '\r' || c == '\n' || c == '\t' {
                ' '
            } else {
                c
            }
        })
        .collect();
    without_breaks
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .to_string()
}

fn has_line_break(value: &str) -> bool {
    value.contains(['\r', '\n', '\0'])
}

fn invalid(param_name: &str, message: impl Into<String>) -> OrbitError {
    OrbitError::unprocessable(error_codes::FORM_PARAM_FORMAT_INVALID, message)
        .with_meta(serde_json::json!({ "param_name": param_name }))
}

/// Address without a display name; the domain must look like a real, dotted domain.
const STRICT_ADDRESS: &str = r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$";
/// `From` may use a bare host such as `no-reply@localhost`.
const FROM_ADDRESS: &str =
    r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,253}[A-Za-z0-9])?$";

/// Validates a recipient and returns the trimmed address.
pub fn normalize_recipient(value: &str) -> Result<String, OrbitError> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    let address = value.trim();
    if address.is_empty()
        || address.chars().count() > 254
        || has_line_break(value)
        || !matches(&RE, STRICT_ADDRESS, address)
    {
        return Err(invalid("to", "to must be a valid email address"));
    }
    Ok(address.to_string())
}

fn format_address(name: Option<&str>, address: &str) -> String {
    match name {
        None | Some("") => address.to_string(),
        Some(name) => {
            let escaped = name.replace('\\', "\\\\").replace('"', "\\\"");
            format!("\"{escaped}\" <{address}>")
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmailFrom {
    pub address: String,
    /// Re-serialised `Display Name <address>`.
    pub value: String,
}

/// Accepts `address` or `Display Name <address>`.
pub fn parse_email_from(value: &str, param_name: &str) -> Result<EmailFrom, OrbitError> {
    static DISPLAY_RE: OnceLock<Option<Regex>> = OnceLock::new();
    static ADDRESS_RE: OnceLock<Option<Regex>> = OnceLock::new();
    let raw = value.trim();
    if raw.is_empty() {
        return Err(invalid(param_name, format!("{param_name} is empty")));
    }
    if has_line_break(raw) || raw.chars().count() > 320 {
        return Err(invalid(
            param_name,
            format!("{param_name} must not contain line breaks"),
        ));
    }
    let parsed = compiled(&DISPLAY_RE, r"^(.*?)\s*<([^<>]+)>$").and_then(|re| re.captures(raw));
    let (address, name) = match parsed {
        Some(captures) => {
            let name = header_safe(
                captures
                    .get(1)
                    .map(|m| m.as_str())
                    .unwrap_or("")
                    .trim_matches('"'),
            );
            (
                captures
                    .get(2)
                    .map(|m| m.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string(),
                name,
            )
        }
        None => (raw.to_string(), String::new()),
    };
    if address.chars().count() > 254 || !matches(&ADDRESS_RE, FROM_ADDRESS, &address) {
        return Err(invalid(
            param_name,
            format!("{param_name} must contain an email address"),
        ));
    }
    Ok(EmailFrom {
        value: format_address(Some(name.as_str()), &address),
        address,
    })
}

#[derive(Clone, PartialEq, Eq)]
pub struct SmtpConnection {
    pub smtp_url: String,
    pub host: String,
    pub port: u16,
    pub secure: bool,
    pub user: Option<String>,
    pub pass: Option<String>,
}

impl std::fmt::Debug for SmtpConnection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SmtpConnection")
            .field("smtp_url", &"<redacted>")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("secure", &self.secure)
            .field("user", &self.user)
            .field("pass", &self.pass)
            .finish()
    }
}

/// Parses and validates an SMTP URL (`smtp://` or `smtps://` only).
pub fn parse_smtp_url(value: &str, param_name: &str) -> Result<SmtpConnection, OrbitError> {
    let raw = value.trim();
    let fail = |why: &str| invalid(param_name, format!("{param_name} {why}"));
    if raw.is_empty() {
        return Err(fail("is empty"));
    }
    if has_line_break(raw) {
        return Err(fail("must not contain line breaks"));
    }
    let url = url::Url::parse(raw).map_err(|_| fail("must be a smtp:// or smtps:// URL"))?;
    if url.scheme() != "smtp" && url.scheme() != "smtps" {
        return Err(fail("must be a smtp:// or smtps:// URL"));
    }
    let Some(host) = url.host_str().filter(|h| !h.is_empty()) else {
        return Err(fail("must include a host"));
    };
    if !url.path().is_empty() && url.path() != "/" {
        return Err(fail("must not include a path"));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(fail("must not include a query or fragment"));
    }
    let secure = url.scheme() == "smtps";
    let port = match url.port() {
        Some(port) => port,
        None => {
            if secure {
                465
            } else {
                587
            }
        }
    };
    if port == 0 {
        return Err(fail("has an invalid port"));
    }
    let decode = |value: &str| -> Result<Option<String>, OrbitError> {
        if value.is_empty() {
            return Ok(None);
        }
        percent_encoding::percent_decode_str(value)
            .decode_utf8()
            .map(|value| Some(value.to_string()))
            .map_err(|_| fail("has an invalid username or password encoding"))
    };
    Ok(SmtpConnection {
        smtp_url: raw.to_string(),
        host: host.to_string(),
        port,
        secure,
        user: decode(url.username())?,
        pass: decode(url.password().unwrap_or(""))?,
    })
}

/// Splits `user:pass@host:port` into a URL safe to log or show.
pub fn redact_smtp_url(value: &str) -> String {
    let Ok(mut url) = url::Url::parse(value.trim()) else {
        return String::new();
    };
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.to_string().trim_end_matches('/').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recipients_are_strict() {
        assert_eq!(
            normalize_recipient("  ada@example.com ").unwrap(),
            "ada@example.com"
        );
        for bad in ["", "ada", "ada@", "ada@localhost", "a@b.c\nevil"] {
            assert!(normalize_recipient(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn from_accepts_display_names_and_bare_hosts() {
        let parsed = parse_email_from("OrbitID <no-reply@localhost>", "email.from").unwrap();
        assert_eq!(parsed.address, "no-reply@localhost");
        assert_eq!(parsed.value, "\"OrbitID\" <no-reply@localhost>");
        assert!(parse_email_from("bad\r\nBcc: x", "email.from").is_err());
        assert!(parse_email_from("No Address", "email.from").is_err());
    }

    #[test]
    fn smtp_urls_parse_like_the_typescript_version() {
        let parsed =
            parse_smtp_url("smtp://mailer:hunter2@smtp.example.com", "email.smtpUrl").unwrap();
        assert_eq!(parsed.host, "smtp.example.com");
        assert_eq!(parsed.port, 587);
        assert!(!parsed.secure);
        assert_eq!(parsed.user.as_deref(), Some("mailer"));
        assert_eq!(parsed.pass.as_deref(), Some("hunter2"));

        let secure = parse_smtp_url("smtps://host:2465", "email.smtpUrl").unwrap();
        assert!(secure.secure);
        assert_eq!(secure.port, 2465);
        for bad in [
            "http://host",
            "smtp://",
            "smtp://host/path",
            "smtp://host?x=1",
        ] {
            assert!(parse_smtp_url(bad, "email.smtpUrl").is_err(), "{bad}");
        }
    }

    #[test]
    fn redaction_removes_credentials() {
        assert_eq!(
            redact_smtp_url("smtp://mailer:hunter2@smtp.example.com:587/"),
            "smtp://smtp.example.com:587"
        );
        assert_eq!(redact_smtp_url("nonsense"), "");
    }
}
