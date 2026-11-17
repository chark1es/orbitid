use std::net::{IpAddr, Ipv4Addr};

use reqwest::header::HeaderMap;
use reqwest::Url;
use serde::de::DeserializeOwned;

use crate::error::{error_codes, OrbitError, Result};
use crate::state::AppState;

pub const DEFAULT_TIMEOUT_MS: u64 = 10_000;
pub const DEFAULT_MAX_REDIRECTS: usize = 3;
pub const DEFAULT_MAX_BYTES: usize = 1024 * 1024;
#[derive(Debug, Clone, Default)]
pub struct SafeFetchOptions {
    pub method: Option<String>,
    pub headers: HeaderMap,
    pub body: Option<Vec<u8>>,
    /// Total time budget for the whole chain, in ms.
    pub timeout_ms: Option<u64>,
    pub max_redirects: Option<usize>,
    pub max_bytes: Option<usize>,
}
#[derive(Debug, Clone)]
pub struct SafeFetchResult {
    pub status: u16,
    pub headers: HeaderMap,
    pub body: String,
}
impl SafeFetchResult {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
    pub fn json<T: DeserializeOwned>(&self) -> Result<T> {
        serde_json::from_str(&self.body)
            .map_err(|_| safe_fetch_error("Response did not contain valid JSON"))
    }
}
/// The TypeScript version subclasses `OrbitError`; so does this (same status/code).
pub fn safe_fetch_error(message: impl Into<String>) -> OrbitError {
    OrbitError::bad_request(error_codes::FORM_PARAM_FORMAT_INVALID, message)
}
/// Private networks are only reachable when the operator opted in.
pub fn private_networks_allowed(state: Option<&AppState>) -> bool {
    if std::env::var("ORBITID_ALLOW_PRIVATE_NETWORKS").as_deref() == Ok("true") {
        return true;
    }
    match state {
        Some(state) => {
            state.env.allow_private_networks || state.settings.get().application.development_mode
        }
        None => false,
    }
}
fn in_v4(address: u32, prefix: [u8; 4], bits: u32) -> bool {
    let prefix = u32::from(Ipv4Addr::new(prefix[0], prefix[1], prefix[2], prefix[3]));
    let mask = if bits == 0 {
        0
    } else {
        u32::MAX << (32 - bits)
    };
    (address & mask) == (prefix & mask)
}
const V4_BLOCKS: [([u8; 4], u32); 14] = [
    ([0, 0, 0, 0], 8),
    ([10, 0, 0, 0], 8),
    ([100, 64, 0, 0], 10),
    ([127, 0, 0, 0], 8),
    ([169, 254, 0, 0], 16),
    ([172, 16, 0, 0], 12),
    ([192, 0, 0, 0], 24),
    ([192, 0, 2, 0], 24),
    ([192, 168, 0, 0], 16),
    ([198, 18, 0, 0], 15),
    ([198, 51, 100, 0], 24),
    ([203, 0, 113, 0], 24),
    ([224, 0, 0, 0], 4),
    ([240, 0, 0, 0], 4),
];
fn v4_verdict(bytes: [u8; 4]) -> bool {
    let address = u32::from(Ipv4Addr::from(bytes));
    V4_BLOCKS
        .iter()
        .any(|(prefix, bits)| in_v4(address, *prefix, *bits))
}
fn v6_verdict(bytes: [u8; 16]) -> bool {
    let zeros = |from: usize, to: usize| bytes[from..to].iter().all(|value| *value == 0);
    // ::, ::1 and IPv4-compatible ::a.b.c.d
    if zeros(0, 12) {
        return if bytes[12] == 0 && bytes[13] == 0 && bytes[14] == 0 {
            true
        } else {
            v4_verdict([bytes[12], bytes[13], bytes[14], bytes[15]])
        };
    }
    if zeros(0, 10) && bytes[10] == 0xff && bytes[11] == 0xff {
        return v4_verdict([bytes[12], bytes[13], bytes[14], bytes[15]]);
    }
    if bytes[0] == 0x00 && bytes[1] == 0x64 && bytes[2] == 0xff && bytes[3] == 0x9b && zeros(4, 12)
    {
        return v4_verdict([bytes[12], bytes[13], bytes[14], bytes[15]]);
    }
    if bytes[0] == 0x20 && bytes[1] == 0x02 {
        return v4_verdict([bytes[2], bytes[3], bytes[4], bytes[5]]);
    }
    if bytes[0] & 0xfe == 0xfc {
        return true; // unique local fc00::/7
    }
    if bytes[0] == 0xfe && bytes[1] & 0xc0 == 0x80 {
        return true; // link-local fe80::/10
    }
    if bytes[0] == 0xfe && bytes[1] & 0xc0 == 0xc0 {
        return true; // site-local fec0::/10
    }
    if bytes[0] == 0xff {
        return true; // multicast
    }
    if bytes[0] == 0x20 && bytes[1] == 0x01 && bytes[2] == 0x0d && bytes[3] == 0xb8 {
        return true; // documentation 2001:db8::/32
    }
    if bytes[0] == 0x01 && zeros(1, 8) {
        return true; // discard-only 100::/64
    }
    false
}
/// True when this address must not be contacted for a user-supplied URL.
pub fn is_private_address(address: &str) -> bool {
    let address = address.trim_matches(['[', ']']);
    match address.parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => v4_verdict(v4.octets()),
        Ok(IpAddr::V6(v6)) => v6_verdict(v6.octets()),
        Err(_) => true,
    }
}
/// Parses + vets a URL: only http(s), no embedded credentials, hostname present.
pub fn parse_external_url(raw: &str) -> Result<Url> {
    let url = Url::parse(raw).map_err(|_| safe_fetch_error("URL is not valid"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(safe_fetch_error("URL must use http or https"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(safe_fetch_error("URLs must not contain credentials"));
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err(safe_fetch_error("URL must name a host"));
    }
    Ok(url)
}
/// Resolves and judges the target. Throws when the destination is not allowed.
pub async fn resolve_public_address(url: &Url, allow_private: bool) -> Result<(IpAddr, u16)> {
    let port = url.port_or_known_default().unwrap_or(80);
    let host = url.host_str().unwrap_or("");
    let host = host.trim_matches(['[', ']']);
    let addresses: Vec<IpAddr> = match url.host() {
        Some(url::Host::Ipv4(address)) => vec![IpAddr::V4(address)],
        Some(url::Host::Ipv6(address)) => vec![IpAddr::V6(address)],
        Some(url::Host::Domain(domain)) => match tokio::net::lookup_host((domain, port)).await {
            Ok(found) => found.map(|address| address.ip()).collect(),
            Err(_) => return Err(safe_fetch_error(format!("Could not resolve {host}"))),
        },
        None => return Err(safe_fetch_error(format!("Could not resolve {host}"))),
    };
    if addresses.is_empty() {
        return Err(safe_fetch_error(format!("Could not resolve {host}")));
    }
    if !allow_private {
        if let Some(blocked) = addresses
            .iter()
            .find(|address| is_private_address(&address.to_string()))
        {
            return Err(safe_fetch_error(format!(
                "{host} resolves to a non-public address ({blocked}); this is not allowed"
            )));
        }
    }
    Ok((addresses[0], port))
}
/// Validates an operator-provided URL at write time. Hostnames are not resolved
/// here; the real guard is `safe_fetch`, which resolves and pins at request time.
pub async fn assert_public_url(
    state: Option<&AppState>,
    raw: &str,
    param_name: &str,
) -> Result<Url> {
    let url = parse_external_url(raw).map_err(|error| {
        OrbitError::unprocessable(error_codes::FORM_PARAM_FORMAT_INVALID, error.message)
            .with_meta(serde_json::json!({ "param_name": param_name }))
    })?;
    let host = url
        .host_str()
        .unwrap_or("")
        .trim_matches(['[', ']'])
        .to_string();
    if host.parse::<IpAddr>().is_ok()
        && !private_networks_allowed(state)
        && is_private_address(&host)
    {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            format!("{host} is a private or loopback address; this is not allowed"),
        )
        .with_meta(serde_json::json!({ "param_name": param_name })));
    }
    Ok(url)
}
