//! Client IP resolution and request security helpers, ported from
//! the retired TypeScript server.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};

use axum::extract::ConnectInfo;
use axum::http::{Extensions, HeaderMap};

static WARNED_MISSING_FORWARDED_FOR: AtomicBool = AtomicBool::new(false);

/// The caller's address. Forwarding headers are client-controlled unless a
/// proxy you run sets them, so by default the socket address is used. Behind
/// `n` trusted proxies only the nth hop from the right of `X-Forwarded-For` is
/// trusted, because it is the one your outermost proxy appended.
pub fn client_ip(headers: &HeaderMap, peer: Option<SocketAddr>, trust_proxy: usize) -> String {
    if trust_proxy > 0 {
        let chain: Vec<&str> = headers
            .get("x-forwarded-for")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .split(',')
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .collect();
        if chain.len() >= trust_proxy {
            let forwarded = chain[chain.len() - trust_proxy];
            if !forwarded.is_empty() {
                return forwarded.to_string();
            }
        }
        if !WARNED_MISSING_FORWARDED_FOR.swap(true, Ordering::Relaxed) {
            tracing::warn!(
                "ORBITID_TRUST_PROXY is set but a request arrived without an X-Forwarded-For hop; \
                 rate limits will treat every such client as the proxy. Make the proxy set X-Forwarded-For."
            );
        }
    }
    peer.map(|address| address.ip().to_string())
        .unwrap_or_else(|| "127.0.0.1".to_string())
}

/// Socket address attached by `into_make_service_with_connect_info`.
pub fn peer_addr(extensions: &Extensions) -> Option<SocketAddr> {
    extensions
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ConnectInfo(address)| *address)
}

/// Whether the browser reached this request over TLS, including through a
/// trusted proxy that terminated TLS.
pub fn request_is_secure(headers: &HeaderMap, base_url: &str, trust_proxy: usize) -> bool {
    if base_url.to_ascii_lowercase().starts_with("https://") {
        return true;
    }
    if trust_proxy > 0 {
        let proto = headers
            .get("x-forwarded-proto")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .split(',')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if !proto.is_empty() {
            return proto == "https";
        }
    }
    false
}

/// Unix epoch milliseconds.
pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(xff: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", HeaderValue::from_str(xff).unwrap());
        headers
    }

    #[test]
    fn ignores_forwarded_header_without_a_trusted_proxy() {
        assert_eq!(client_ip(&headers("203.0.113.9"), None, 0), "127.0.0.1");
    }

    #[test]
    fn takes_the_hop_the_proxy_appended() {
        assert_eq!(
            client_ip(&headers("6.6.6.6, 198.51.100.4"), None, 1),
            "198.51.100.4"
        );
        assert_eq!(
            client_ip(&headers("6.6.6.6, 198.51.100.4, 10.0.0.2"), None, 2),
            "198.51.100.4"
        );
    }

    #[test]
    fn falls_back_to_the_socket_address() {
        let peer: SocketAddr = "10.0.0.5:1234".parse().unwrap();
        assert_eq!(client_ip(&HeaderMap::new(), Some(peer), 0), "10.0.0.5");
    }

    #[test]
    fn secure_detection() {
        assert!(request_is_secure(
            &HeaderMap::new(),
            "https://auth.example.com",
            0
        ));
        assert!(!request_is_secure(
            &HeaderMap::new(),
            "http://localhost:4000",
            0
        ));
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-proto", HeaderValue::from_static("https"));
        assert!(request_is_secure(&headers, "http://localhost:4000", 1));
        assert!(!request_is_secure(&headers, "http://localhost:4000", 0));
    }
}
