use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderValue, LOCATION};
use reqwest::Url;
use serde::de::DeserializeOwned;

use crate::error::Result;
use crate::state::AppState;

use super::*;

fn method_of(options: &SafeFetchOptions) -> reqwest::Method {
    options
        .method
        .as_deref()
        .and_then(|method| reqwest::Method::from_bytes(method.to_ascii_uppercase().as_bytes()).ok())
        .unwrap_or(reqwest::Method::GET)
}

async fn send_once(
    url: &Url,
    address: IpAddr,
    port: u16,
    options: &SafeFetchOptions,
    timeout: Duration,
) -> Result<SafeFetchResult> {
    let mut builder = reqwest::Client::builder()
        .use_rustls_tls()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .timeout(timeout);
    if let Some(url::Host::Domain(domain)) = url.host() {
        builder = builder.resolve(domain, SocketAddr::new(address, port));
    }
    let client = builder
        .build()
        .map_err(|error| safe_fetch_error(error.to_string()))?;

    let method = method_of(options);
    let mut request = client.request(method.clone(), url.clone());
    if !options.headers.is_empty() {
        request = request.headers(options.headers.clone());
    }
    if let Some(body) = &options.body {
        if method != reqwest::Method::GET && method != reqwest::Method::HEAD {
            request = request.body(body.clone());
        }
    }
    let response = request.send().await.map_err(|error| {
        if error.is_timeout() {
            safe_fetch_error(format!(
                "Request to {} timed out",
                url.host_str().unwrap_or("the target")
            ))
        } else {
            safe_fetch_error(error.to_string())
        }
    })?;
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let max_bytes = options.max_bytes.unwrap_or(DEFAULT_MAX_BYTES);
    let mut body = Vec::new();
    let mut response = response;
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if body.len() + chunk.len() > max_bytes {
                    return Err(safe_fetch_error(format!(
                        "Response from {} exceeds {max_bytes} bytes",
                        url.host_str().unwrap_or("the target")
                    )));
                }
                body.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(error) => return Err(safe_fetch_error(error.to_string())),
        }
    }
    Ok(SafeFetchResult {
        status,
        headers,
        body: String::from_utf8_lossy(&body).into_owned(),
    })
}

fn same_origin(from: &Url, to: &Url) -> bool {
    from.origin() == to.origin()
}

const SENSITIVE_HEADERS: [&str; 3] = ["authorization", "proxy-authorization", "cookie"];

/// What a redirect may carry along: secrets never cross origins, https never
/// falls back to http, and a body is only replayed by 307/308 to the same origin.
fn redirect_options(
    from: &Url,
    to: &Url,
    status: u16,
    options: &SafeFetchOptions,
) -> Result<SafeFetchOptions> {
    if from.scheme() == "https" && to.scheme() == "http" {
        return Err(safe_fetch_error("Refusing a redirect from https to http"));
    }
    let same = same_origin(from, to);
    let mut headers = HeaderMap::new();
    for (name, value) in &options.headers {
        if !same && SENSITIVE_HEADERS.contains(&name.as_str()) {
            continue;
        }
        headers.append(name.clone(), value.clone());
    }
    let method = method_of(options);
    let has_body = options.body.is_some();
    if status == 307 || status == 308 {
        if has_body && !same {
            return Err(safe_fetch_error(
                "Refusing a redirect that would resend the request body to another origin",
            ));
        }
        return Ok(SafeFetchOptions {
            headers,
            ..options.clone()
        });
    }
    if method == reqwest::Method::GET || method == reqwest::Method::HEAD {
        return Ok(SafeFetchOptions {
            headers,
            ..options.clone()
        });
    }
    headers.remove(reqwest::header::CONTENT_TYPE);
    headers.remove(reqwest::header::CONTENT_LENGTH);
    Ok(SafeFetchOptions {
        method: Some("GET".into()),
        body: None,
        headers,
        ..options.clone()
    })
}

/// Test seam for calls to fixed public hosts that tests must not reach.
#[cfg(feature = "test-util")]
#[async_trait::async_trait]
pub trait SafeFetchTransport: Send + Sync {
    async fn call(&self, url: &Url, options: &SafeFetchOptions) -> Result<SafeFetchResult>;
}

#[cfg(feature = "test-util")]
use std::sync::{OnceLock, RwLock};

#[cfg(feature = "test-util")]
static TEST_TRANSPORT: OnceLock<RwLock<Option<std::sync::Arc<dyn SafeFetchTransport>>>> =
    OnceLock::new();

#[cfg(feature = "test-util")]
pub fn set_safe_fetch_transport_for_tests(
    transport: Option<std::sync::Arc<dyn SafeFetchTransport>>,
) {
    let slot = TEST_TRANSPORT.get_or_init(|| RwLock::new(None));
    if let Ok(mut guard) = slot.write() {
        *guard = transport;
    }
}

#[cfg(feature = "test-util")]
fn test_transport() -> Option<std::sync::Arc<dyn SafeFetchTransport>> {
    TEST_TRANSPORT
        .get()
        .and_then(|slot| slot.read().ok().and_then(|guard| guard.clone()))
}

/// `fetch` for URLs a user or admin controls, with SSRF, redirect and size guards.
pub async fn safe_fetch(
    state: Option<&AppState>,
    raw_url: &str,
    options: SafeFetchOptions,
) -> Result<SafeFetchResult> {
    let allow_private = private_networks_allowed(state);
    let timeout_ms = options.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
    let max_redirects = options.max_redirects.unwrap_or(DEFAULT_MAX_REDIRECTS);
    let raw_host = Url::parse(raw_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .unwrap_or_else(|| "the target".to_string());

    #[cfg(feature = "test-util")]
    let transport = test_transport();

    let budget = Duration::from_millis(timeout_ms);
    let result = tokio::time::timeout(budget, async {
        let mut url = parse_external_url(raw_url)?;
        let mut current = options;
        let mut hop = 0usize;
        loop {
            #[cfg(feature = "test-util")]
            let response = match &transport {
                Some(transport) => transport.call(&url, &current).await?,
                None => {
                    let (address, port) = resolve_public_address(&url, allow_private).await?;
                    send_once(&url, address, port, &current, budget).await?
                }
            };
            #[cfg(not(feature = "test-util"))]
            let response = {
                let (address, port) = resolve_public_address(&url, allow_private).await?;
                send_once(&url, address, port, &current, budget).await?
            };

            if (300..400).contains(&response.status) {
                if let Some(location) = response.headers.get(LOCATION) {
                    if hop >= max_redirects {
                        return Err(safe_fetch_error(format!(
                            "Too many redirects (more than {max_redirects})"
                        )));
                    }
                    let location = location
                        .to_str()
                        .map_err(|_| safe_fetch_error("Redirect location is not a valid URL"))?;
                    let joined = url
                        .join(location)
                        .map_err(|_| safe_fetch_error("Redirect location is not a valid URL"))?;
                    let next = parse_external_url(joined.as_str())?;
                    current = redirect_options(&url, &next, response.status, &current)?;
                    url = next;
                    hop += 1;
                    continue;
                }
            }
            return Ok(response);
        }
    })
    .await;

    match result {
        Ok(value) => value,
        Err(_) => Err(safe_fetch_error(format!("Request to {raw_host} timed out"))),
    }
}

/// Convenience wrapper: performs the request and parses JSON.
pub async fn safe_fetch_json<T: DeserializeOwned>(
    state: Option<&AppState>,
    raw_url: &str,
    options: SafeFetchOptions,
) -> Result<T> {
    let response = safe_fetch(state, raw_url, options).await?;
    if !response.ok() {
        let host = Url::parse(raw_url)
            .ok()
            .and_then(|url| url.host_str().map(str::to_string))
            .unwrap_or_else(|| "the target".to_string());
        return Err(safe_fetch_error(format!(
            "Request to {host} failed ({})",
            response.status
        )));
    }
    response.json().map_err(|_| {
        let host = Url::parse(raw_url)
            .ok()
            .and_then(|url| url.host_str().map(str::to_string))
            .unwrap_or_else(|| "the target".to_string());
        safe_fetch_error(format!("Request to {host} did not return JSON"))
    })
}

/// Builds a header map from pairs; useful for callers without `http` types.
pub fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
    let mut map = HeaderMap::new();
    for (name, value) in pairs {
        if let (Ok(name), Ok(value)) = (
            name.parse::<reqwest::header::HeaderName>(),
            HeaderValue::from_str(value),
        ) {
            map.insert(name, value);
        }
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocked_ipv4_ranges() {
        for address in [
            "127.0.0.1",
            "127.9.9.9",
            "10.0.0.1",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "224.0.0.1",
            "240.0.0.1",
            "192.0.2.5",
            "198.51.100.7",
            "203.0.113.9",
            "198.18.0.1",
        ] {
            assert!(is_private_address(address), "{address}");
        }
    }

    #[test]
    fn allowed_ipv4_ranges() {
        for address in [
            "8.8.8.8",
            "1.1.1.1",
            "93.184.216.34",
            "172.15.255.255",
            "172.32.0.1",
            "100.63.255.255",
            "100.128.0.0",
        ] {
            assert!(!is_private_address(address), "{address}");
        }
    }

    #[test]
    fn blocked_ipv6_ranges() {
        for address in [
            "::",
            "::1",
            "::ffff:127.0.0.1",
            "::ffff:7f00:1",
            "::127.0.0.1",
            "64:ff9b::7f00:1",
            "2002:7f00:1::1",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "fec0::1",
            "ff02::1",
            "2001:db8::1",
            "100::1",
        ] {
            assert!(is_private_address(address), "{address}");
        }
    }

    #[test]
    fn allowed_ipv6_ranges() {
        for address in [
            "2001:4860:4860::8888",
            "2606:4700:4700::1111",
            "::ffff:8.8.8.8",
            "64:ff9b::808:808",
            "2002:808:808::",
        ] {
            assert!(!is_private_address(address), "{address}");
        }
    }

    #[test]
    fn url_validation() {
        assert!(parse_external_url("file:///etc/passwd").is_err());
        assert!(parse_external_url("gopher://example.com/").is_err());
        assert!(parse_external_url("http://user:pass@example.com/").is_err());
        assert!(parse_external_url("https://example.com/path").is_ok());
    }

    #[test]
    fn redirects_drop_credentials_and_bodies_cross_origin() {
        let from = Url::parse("https://a.example/x").unwrap();
        let to = Url::parse("https://b.example/y").unwrap();
        let options = SafeFetchOptions {
            method: Some("POST".into()),
            headers: headers(&[("authorization", "Bearer secret"), ("x-keep", "1")]),
            body: Some(b"x=1".to_vec()),
            ..Default::default()
        };
        let next = redirect_options(&from, &to, 302, &options).unwrap();
        assert_eq!(next.method.as_deref(), Some("GET"));
        assert!(next.body.is_none());
        assert!(next.headers.get("authorization").is_none());
        assert!(next.headers.get("x-keep").is_some());
        assert!(redirect_options(&from, &to, 307, &options).is_err());

        let same = Url::parse("https://a.example/again").unwrap();
        let next = redirect_options(&from, &same, 307, &options).unwrap();
        assert_eq!(next.method.as_deref(), Some("POST"));
        assert!(next.headers.get("authorization").is_some());
    }

    #[test]
    fn refuses_https_to_http() {
        let from = Url::parse("https://a.example/x").unwrap();
        let to = Url::parse("http://a.example/y").unwrap();
        assert!(redirect_options(&from, &to, 301, &SafeFetchOptions::default()).is_err());
    }
}
