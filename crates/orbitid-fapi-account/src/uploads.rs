//! Uploaded-image storage in Postgres and the two request encodings the
//! Frontend API accepts (`multipart/form-data` and a JSON base64 data URL).
//!
//! The TypeScript server wrote avatars to `<dataDir>/uploads` and organization
//! logos to `<dataDir>/uploads/orgs`. That is single-replica state; the public
//! URLs are unchanged but the bytes live in the `uploads` table (migration
//! `0004_uploads.sql`) so any replica can serve them.

use axum::http::HeaderMap;
use base64::Engine;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::MAX_UPLOAD_BYTES;
use orbitid_platform::images::ImageKind;

pub const MAX_IMAGE_BYTES: usize = MAX_UPLOAD_BYTES;

pub use orbitid_identity::uploads::{
    avatar_content_type, file_from_url, is_safe_file_name, logo_content_type, read_upload,
    store_upload_on, StoredUpload, AVATAR_BUCKET, AVATAR_MARKER, LOGO_BUCKET, LOGO_MARKER,
};

/// `randomImageName(prefix, kind)`: client file names never reach storage.
pub fn random_image_name(prefix: &str, kind: ImageKind) -> String {
    orbitid_platform::images::random_image_name(prefix, kind)
}

/// A multipart file part.
pub struct MultipartFile {
    pub bytes: Vec<u8>,
}

/// Extracts one file field from a `multipart/form-data` body.
///
/// Implemented locally: the workspace does not depend on `multer`, and the
/// Frontend API only ever accepts a single bounded `file` part.
pub fn multipart_file(content_type: &str, body: &[u8], field: &str) -> Option<MultipartFile> {
    let boundary = content_type
        .split(';')
        .map(str::trim)
        .find_map(|part| part.strip_prefix("boundary="))
        .map(|value| value.trim_matches('"').to_string())?;
    if boundary.is_empty() {
        return None;
    }
    let delimiter = format!("--{boundary}");
    // Split on the delimiter; the first chunk is the preamble.
    let mut parts = split_bytes(body, delimiter.as_bytes());
    parts.reverse();
    parts.pop();
    for part in parts {
        // Each part is `\r\n<headers>\r\n\r\n<body>` with a trailing `\r\n`
        // before the next delimiter (or `--` for the final one).
        let part = strip_prefix(part, b"\r\n");
        let Some(split) = find_subslice(part, b"\r\n\r\n") else {
            continue;
        };
        let (head, body) = (&part[..split], &part[split + 4..]);
        let head = String::from_utf8_lossy(head);
        let disposition = head
            .lines()
            .find(|line| {
                line.to_ascii_lowercase()
                    .starts_with("content-disposition:")
            })
            .unwrap_or("");
        let name = disposition_attribute(disposition, "name");
        if name.as_deref() != Some(field) {
            continue;
        }
        // A non-file form field (no `filename=`) is not a file.
        disposition_attribute(disposition, "filename")?;
        let body = body.strip_suffix(b"\r\n").unwrap_or(body);
        let body = body.strip_suffix(b"--").unwrap_or(body);
        return Some(MultipartFile {
            bytes: body.to_vec(),
        });
    }
    None
}

fn disposition_attribute(disposition: &str, attribute: &str) -> Option<String> {
    let needle = format!("{attribute}=\"");
    let start = disposition.find(&needle)? + needle.len();
    let rest = &disposition[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

fn strip_prefix<'a>(value: &'a [u8], prefix: &[u8]) -> &'a [u8] {
    value.strip_prefix(prefix).unwrap_or(value)
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn split_bytes<'a>(value: &'a [u8], delimiter: &[u8]) -> Vec<&'a [u8]> {
    let mut out = Vec::new();
    let mut rest = value;
    while let Some(index) = find_subslice(rest, delimiter) {
        out.push(&rest[..index]);
        rest = &rest[index + delimiter.len()..];
    }
    out.push(rest);
    out
}

/// Decodes the JSON/base64 upload shape (`data:<mime>;base64,<payload>` or a
/// bare base64 string). `param` names the request field in errors.
pub fn decode_image_payload(raw: &str, param: &str) -> Result<Vec<u8>> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_VALUE_INVALID,
            "The uploaded file is empty",
        )
        .with_meta(serde_json::json!({ "param_name": param })));
    }
    let payload = strip_data_url_prefix(trimmed);
    base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|_| {
            OrbitError::unprocessable(
                error_codes::FORM_PARAM_FORMAT_INVALID,
                "The file is not valid base64",
            )
            .with_meta(serde_json::json!({ "param_name": param }))
        })
}

fn strip_data_url_prefix(value: &str) -> &str {
    // `^data:([a-z0-9.+/-]+);base64,(.+)$` — case-insensitive scheme.
    if value.len() > 5 && value[..5].eq_ignore_ascii_case("data:") {
        if let Some((meta, payload)) = value[5..].split_once(',') {
            let meta = meta.trim();
            if meta.to_ascii_lowercase().ends_with(";base64") {
                return payload;
            }
        }
    }
    value
}

/// A logo payload from `multipart/form-data`.
pub struct LogoPayload {
    pub bytes: Vec<u8>,
}

/// `readLogoPayload(c)`'s multipart branch: one bounded `file` part.
pub fn logo_from_multipart(
    content_type: &str,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<LogoPayload> {
    let declared = headers
        .get(axum::http::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    if declared > MAX_IMAGE_BYTES + 64 * 1024 {
        return Err(too_large("Logo must be smaller than 5MB"));
    }
    let Some(file) = multipart_file(content_type, body, "file") else {
        return Err(
            OrbitError::unprocessable(error_codes::FORM_PARAM_MISSING, "file is missing")
                .with_meta(serde_json::json!({ "param_name": "file" })),
        );
    };
    if file.bytes.len() > MAX_IMAGE_BYTES {
        return Err(too_large("Logo must be smaller than 5MB"));
    }
    Ok(LogoPayload { bytes: file.bytes })
}

/// `readDataUrl(value)`: a logo must be a base64 data URL (never a remote URL
/// the server would fetch).
pub fn logo_from_json_value(value: &serde_json::Value) -> Result<LogoPayload> {
    let Some(file) = value.get("file").and_then(serde_json::Value::as_str) else {
        return Err(
            OrbitError::unprocessable(error_codes::FORM_PARAM_MISSING, "file is missing")
                .with_meta(serde_json::json!({ "param_name": "file" })),
        );
    };
    if file.trim().is_empty() {
        return Err(
            OrbitError::unprocessable(error_codes::FORM_PARAM_MISSING, "file is missing")
                .with_meta(serde_json::json!({ "param_name": "file" })),
        );
    }
    if !is_data_url(file) {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "file must be a base64 data URL",
        )
        .with_meta(serde_json::json!({ "param_name": "file" })));
    }
    let bytes = decode_image_payload(file, "file")?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(too_large("Logo must be smaller than 5MB"));
    }
    Ok(LogoPayload { bytes })
}

fn is_data_url(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.len() <= 5 || !trimmed[..5].eq_ignore_ascii_case("data:") {
        return false;
    }
    match trimmed[5..].split_once(',') {
        Some((meta, payload)) => {
            !payload.is_empty() && meta.trim().to_ascii_lowercase().ends_with(";base64")
        }
        None => false,
    }
}

fn too_large(message: &str) -> OrbitError {
    OrbitError::new(
        axum::http::StatusCode::PAYLOAD_TOO_LARGE,
        error_codes::FORM_PARAM_FORMAT_INVALID,
        message,
    )
    .with_meta(serde_json::json!({ "param_name": "file" }))
}
