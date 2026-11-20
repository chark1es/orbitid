//! Static dashboard serving, ported from the retired TypeScript server.

use std::path::{Component, Path, PathBuf};

use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use orbitid_core::error::route_not_found;
use orbitid_core::http::security::{csp_nonce, dashboard_csp};
use orbitid_core::AppState;

const API_PREFIXES: [&str; 6] = [
    "/v1",
    "/oauth",
    "/.well-known",
    "/health",
    "/ready",
    "/docs",
];

pub fn is_api_path(path: &str) -> bool {
    API_PREFIXES
        .iter()
        .any(|prefix| path == *prefix || path.starts_with(&format!("{prefix}/")))
}

fn index_path(state: &AppState) -> PathBuf {
    state.env.dashboard_dir.join("index.html")
}

/// Whether a built dashboard exists. Checked per request so a build that
/// appears after boot is picked up, like the TypeScript handler's `existsSync`.
pub fn dashboard_available(state: &AppState) -> bool {
    index_path(state).is_file()
}

fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|value| value.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") | Some("map") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("txt") => "text/plain; charset=utf-8",
        Some("webp") => "image/webp",
        _ => "application/octet-stream",
    }
}

/// Adds the nonce to every inline `<script>`; external `src` scripts stay as they are.
fn with_nonce(html: &str, nonce: &str) -> String {
    let mut out = String::with_capacity(html.len() + 64);
    let mut rest = html;
    while let Some(start) = rest.to_ascii_lowercase().find("<script") {
        let (before, after) = rest.split_at(start);
        out.push_str(before);
        let Some(end) = after.find('>') else {
            out.push_str(after);
            return out;
        };
        let (tag, tail) = after.split_at(end + 1);
        let lower = tag.to_ascii_lowercase();
        if lower.contains("src=") || lower.contains("nonce=") {
            out.push_str(tag);
        } else {
            let rest_of_tag = &tag["<script".len()..];
            out.push_str(&format!("<script nonce=\"{nonce}\"{rest_of_tag}"));
        }
        rest = tail;
    }
    out.push_str(rest);
    out
}

fn safe_relative(path: &str) -> Option<PathBuf> {
    // `path` is already percent-decoded by the caller (like the TS handler's
    // `decodeURIComponent`); decoding twice would turn `%252e%252e` into `..`.
    let mut out = PathBuf::new();
    for component in Path::new(path.trim_start_matches('/')).components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    Some(out)
}

/// Whether the request's `Accept-Encoding` allows `coding` (`q=0` refuses it).
fn accepts(accept_encoding: &str, coding: &str) -> bool {
    accept_encoding.split(',').any(|entry| {
        let mut parts = entry.split(';');
        let name = parts.next().unwrap_or("").trim();
        if !name.eq_ignore_ascii_case(coding) && name != "*" {
            return false;
        }
        let quality = parts
            .filter_map(|param| param.trim().strip_prefix("q="))
            .find_map(|value| value.trim().parse::<f32>().ok())
            .unwrap_or(1.0);
        quality > 0.0
    })
}

/// The dashboard build ships `.br` and `.gz` siblings for its text assets. Serve
/// the smallest one the browser accepts; the original otherwise.
async fn precompressed(file: &Path, accept_encoding: &str) -> (PathBuf, Option<&'static str>) {
    for (coding, extension) in [("br", "br"), ("gzip", "gz")] {
        if !accepts(accept_encoding, coding) {
            continue;
        }
        let mut name = file.as_os_str().to_owned();
        name.push(".");
        name.push(extension);
        let candidate = PathBuf::from(name);
        if tokio::fs::metadata(&candidate)
            .await
            .is_ok_and(|meta| meta.is_file())
        {
            return (candidate, Some(coding));
        }
    }
    (file.to_path_buf(), None)
}

/// Serves one dashboard request. Only called for non-API GET paths when a build exists.
pub async fn serve(state: &AppState, path: &str, accept_encoding: &str) -> Response {
    let root = &state.env.dashboard_dir;
    if let Some(relative) = safe_relative(path) {
        if !relative.as_os_str().is_empty() {
            let candidate = root.join(&relative);
            if let (Ok(canonical), Ok(root_canonical)) = (
                tokio::fs::canonicalize(&candidate).await,
                tokio::fs::canonicalize(root).await,
            ) {
                let index = index_path(state);
                if canonical.starts_with(&root_canonical)
                    && canonical != index
                    && canonical.is_file()
                {
                    let (file, encoding) = precompressed(&canonical, accept_encoding).await;
                    if let Ok(bytes) = tokio::fs::read(&file).await {
                        let immutable = path.starts_with("/assets/");
                        let cache = if immutable {
                            "public, max-age=31536000, immutable"
                        } else {
                            "public, max-age=300"
                        };
                        let mut response = bytes.into_response();
                        let headers = response.headers_mut();
                        headers.insert(
                            header::CONTENT_TYPE,
                            HeaderValue::from_static(mime_for(&canonical)),
                        );
                        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
                        headers.insert(header::VARY, HeaderValue::from_static("accept-encoding"));
                        if let Some(encoding) = encoding {
                            headers.insert(
                                header::CONTENT_ENCODING,
                                HeaderValue::from_static(encoding),
                            );
                        }
                        return response;
                    }
                }
            }
        }
    }

    let Ok(index) = tokio::fs::read_to_string(index_path(state)).await else {
        return route_not_found().into_response();
    };
    let nonce = csp_nonce();
    let bootstrap = serde_json::json!({
        "apiUrl": state.env.base_url,
        "publishableKey": state.publishable_key,
        "database": "postgres",
    });
    let injection = format!(
        "<script nonce=\"{nonce}\">window.__ORBITID__={}</script>",
        serde_json::to_string(&bootstrap).unwrap_or_else(|_| "{}".to_string())
    );
    let html = with_nonce(&index, &nonce).replace("</head>", &format!("{injection}</head>"));
    let mut response = (StatusCode::OK, html).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    if let Ok(value) = HeaderValue::from_str(&dashboard_csp(&nonce)) {
        headers.insert(header::CONTENT_SECURITY_POLICY, value);
    }
    headers.insert(
        header::HeaderName::from_static("x-frame-options"),
        HeaderValue::from_static("DENY"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_paths_are_never_dashboard() {
        assert!(is_api_path("/v1"));
        assert!(is_api_path("/v1/client"));
        assert!(is_api_path("/oauth/token"));
        assert!(is_api_path("/health"));
        assert!(is_api_path("/ready"));
        assert!(!is_api_path("/"));
        assert!(!is_api_path("/assets/app.js"));
    }

    #[test]
    fn nonce_only_goes_on_inline_scripts() {
        let html = with_nonce(
            "<script>a</script><script src=\"/x.js\"></script><script nonce=\"n\">b</script>",
            "abc",
        );
        assert!(html.contains("<script nonce=\"abc\">a</script>"));
        assert!(html.contains("<script src=\"/x.js\"></script>"));
        assert!(html.contains("<script nonce=\"n\">b</script>"));
    }

    #[test]
    fn accept_encoding_is_parsed() {
        assert!(accepts("gzip, deflate, br, zstd", "br"));
        assert!(accepts("gzip;q=0.8, br;q=1", "gzip"));
        assert!(accepts("*", "br"));
        assert!(!accepts("gzip", "br"));
        assert!(!accepts("br;q=0, gzip", "br"));
        assert!(!accepts("br;q=0.000", "br"));
        assert!(accepts("br;q=0.5", "br"));
        assert!(!accepts("", "gzip"));
    }

    #[tokio::test]
    async fn precompressed_siblings_are_preferred() {
        let dir =
            std::env::temp_dir().join(format!("orbitid-precompressed-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("app.js");
        std::fs::write(&file, "plain").unwrap();
        std::fs::write(dir.join("app.js.gz"), "gz").unwrap();
        assert_eq!(
            precompressed(&file, "gzip, br").await,
            (dir.join("app.js.gz"), Some("gzip"))
        );
        std::fs::write(dir.join("app.js.br"), "br").unwrap();
        assert_eq!(
            precompressed(&file, "gzip, br").await,
            (dir.join("app.js.br"), Some("br"))
        );
        assert_eq!(precompressed(&file, "identity").await, (file.clone(), None));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn path_traversal_is_refused() {
        assert!(safe_relative("/../../etc/passwd").is_none());
        assert_eq!(
            safe_relative("/assets/app.js").unwrap().to_str(),
            Some("assets/app.js")
        );
    }
}
