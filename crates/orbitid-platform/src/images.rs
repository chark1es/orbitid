//! Image upload sniffing and the generated default avatar.
//!
//! Ported from the retired TypeScript server (and `DEFAULT_AVATAR` from
//! `serializers.ts`). The bytes decide, never the declared content type or file
//! extension. SVG is refused unconditionally: it is an XML document, so it can
//! carry script and would be an XSS vector when served from this origin.

use orbitid_core::error::{error_codes, OrbitError};
use rand::RngCore;

use crate::js::encode_uri_component;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ImageKind {
    Png,
    Jpg,
    Gif,
    Webp,
}

impl ImageKind {
    /// The wire `Content-Type` for a stored image of this kind.
    pub fn content_type(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpg => "image/jpeg",
            Self::Gif => "image/gif",
            Self::Webp => "image/webp",
        }
    }

    /// The file extension used for a stored image of this kind.
    pub fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpg => "jpg",
            Self::Gif => "gif",
            Self::Webp => "webp",
        }
    }

    /// The lower-case format name (`png`, `jpg`, `gif`, `webp`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpg => "jpg",
            Self::Gif => "gif",
            Self::Webp => "webp",
        }
    }
}

/// Response headers for a stored image: never sniffed, and sandboxed in case a
/// decoder is fooled.
pub const IMAGE_RESPONSE_HEADERS: [(&str, &str); 2] = [
    ("x-content-type-options", "nosniff"),
    ("content-security-policy", "sandbox"),
];

const PNG_SIGNATURE: [u8; 8] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/// Markup signatures that must never appear in an uploaded raster image: a
/// polyglot is a file whose header makes it look like an image while its body is
/// HTML/SVG/script.
const MARKUP_MARKERS: [&str; 8] = [
    "<script",
    "<svg",
    "<?xml",
    "<!doctype",
    "<html",
    "<iframe",
    "<body",
    "javascript:",
];

fn latin1_lowercase(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|byte| {
            let character = char::from(*byte);
            character.to_ascii_lowercase()
        })
        .collect()
}

/// True when the buffer contains a markup/script signature anywhere.
pub fn contains_markup(bytes: &[u8]) -> bool {
    let text = latin1_lowercase(bytes);
    MARKUP_MARKERS.iter().any(|marker| text.contains(marker))
}

/// Detects the real format from the first bytes, or `None` for anything else
/// (including SVG and polyglots).
pub fn sniff_image(bytes: &[u8]) -> Option<ImageKind> {
    let kind = if bytes.len() >= 8 && bytes[..8] == PNG_SIGNATURE {
        Some(ImageKind::Png)
    } else if bytes.len() >= 3 && bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff {
        // JPEG: SOI marker followed by a segment marker.
        Some(ImageKind::Jpg)
    } else if bytes.len() >= 6 && (bytes[..6] == *b"GIF87a" || bytes[..6] == *b"GIF89a") {
        Some(ImageKind::Gif)
    } else if bytes.len() >= 12 && bytes[..4] == *b"RIFF" && bytes[8..12] == *b"WEBP" {
        // An appended payload (declared RIFF size does not cover the file) is a polyglot.
        let declared = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
        if u64::from(declared) + 8 == bytes.len() as u64 {
            Some(ImageKind::Webp)
        } else {
            None
        }
    } else {
        None
    }?;
    if contains_markup(bytes) {
        None
    } else {
        Some(kind)
    }
}

/// True when the payload looks like SVG/XML/HTML rather than a raster image.
pub fn looks_like_markup(bytes: &[u8]) -> bool {
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(512)]);
    let head = head.trim_start().to_lowercase();
    ["<?xml", "<svg", "<html", "<!doctype", "<script"]
        .iter()
        .any(|prefix| head.starts_with(prefix))
}

/// Rejects anything that is not PNG, JPEG, GIF or WebP, whatever the client declared.
pub fn assert_image_bytes(bytes: &[u8], param_name: &str) -> Result<ImageKind, OrbitError> {
    if let Some(kind) = sniff_image(bytes) {
        return Ok(kind);
    }
    let message = if looks_like_markup(bytes) {
        "SVG and other markup files are not accepted; upload a PNG, JPEG, GIF or WebP image"
    } else {
        "The file is not a valid PNG, JPEG, GIF or WebP image"
    };
    Err(
        OrbitError::unprocessable(error_codes::FORM_PARAM_FORMAT_INVALID, message)
            .with_meta(serde_json::json!({ "param_name": param_name })),
    )
}

/// Random, server-chosen file name. Client names never reach the filesystem.
pub fn random_image_name(prefix: &str, kind: ImageKind) -> String {
    let mut bytes = [0u8; 12];
    rand::rng().fill_bytes(&mut bytes);
    let suffix: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{prefix}_{suffix}.{}", kind.extension())
}

/// Low-chroma tints, so a list of people reads as one set instead of a rainbow.
const AVATAR_TINTS: [&str; 6] = [
    "#d9d4cc", "#cfd3d6", "#d6d0c4", "#c9cfc8", "#d8cfd0", "#cbd0d9",
];

fn initials_of(seed: &str) -> String {
    let local = seed.split('@').next().unwrap_or("");
    let words: Vec<&str> = local
        .split(|character: char| {
            character.is_whitespace() || character == '.' || character == '_' || character == '-'
        })
        .collect();
    let mut initials = String::new();
    for word in words {
        if let Some(character) = word.chars().find(|character| character.is_alphanumeric()) {
            for upper in character.to_uppercase() {
                initials.push(upper);
            }
            if initials.chars().count() >= 2 {
                break;
            }
        }
    }
    if initials.is_empty() {
        "?".to_string()
    } else {
        initials
    }
}

/// A generated initials image, made here. Nothing is fetched from a third party.
pub fn default_avatar(seed: &str) -> String {
    let mut hash: u32 = 0;
    for unit in seed.encode_utf16() {
        hash = hash.wrapping_mul(31).wrapping_add(u32::from(unit));
    }
    let tint = AVATAR_TINTS[(hash as usize) % AVATAR_TINTS.len()];
    let svg = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\"><rect width=\"64\" height=\"64\" fill=\"{tint}\"/><text x=\"32\" y=\"32\" dy=\".35em\" text-anchor=\"middle\" font-family=\"Helvetica, Arial, sans-serif\" font-size=\"26\" font-weight=\"600\" fill=\"#2a2623\">{}</text></svg>",
        initials_of(seed)
    );
    format!("data:image/svg+xml;utf8,{}", encode_uri_component(&svg))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG_1X1: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x00, 0x00, 0x00, 0x00, 0x3a,
        0x7e, 0x9b, 0x55,
    ];
    const JPEG_1X1: &[u8] = &[
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00,
        0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
    ];
    const GIF_1X1: &[u8] = &[
        b'G', b'I', b'F', b'8', b'9', b'a', 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x3b,
    ];

    fn webp_1x1() -> Vec<u8> {
        let mut payload = Vec::from(*b"WEBPVP8 ");
        payload.extend_from_slice(&[0u8; 8]);
        let mut file = Vec::from(*b"RIFF");
        file.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        file.extend_from_slice(&payload);
        file
    }

    const SVG_PAYLOAD: &[u8] =
        b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>";

    #[test]
    fn detects_the_four_allowed_formats() {
        assert_eq!(sniff_image(PNG_1X1), Some(ImageKind::Png));
        assert_eq!(sniff_image(JPEG_1X1), Some(ImageKind::Jpg));
        assert_eq!(sniff_image(GIF_1X1), Some(ImageKind::Gif));
        assert_eq!(sniff_image(&webp_1x1()), Some(ImageKind::Webp));
    }

    #[test]
    fn refuses_markup_and_unknown_bytes() {
        assert_eq!(sniff_image(SVG_PAYLOAD), None);
        assert!(looks_like_markup(SVG_PAYLOAD));
        assert_eq!(sniff_image(b"<html></html>"), None);
        assert_eq!(sniff_image(b"not an image"), None);
        assert_eq!(sniff_image(&[]), None);
    }

    #[test]
    fn refuses_polyglots() {
        let mut gif = GIF_1X1.to_vec();
        gif.extend_from_slice(b"<html><script>alert(1)</script></html>");
        assert_eq!(sniff_image(&gif), None);

        let mut png = PNG_1X1.to_vec();
        png.extend_from_slice(b"<script>alert(1)</script>");
        assert_eq!(sniff_image(&png), None);

        let mut lying = webp_1x1();
        lying[4..8].copy_from_slice(&4u32.to_le_bytes());
        assert_eq!(sniff_image(&lying), None);
    }

    #[test]
    fn assertion_messages_explain_svg() {
        let error = assert_image_bytes(SVG_PAYLOAD, "file").unwrap_err();
        assert_eq!(error.status, axum::http::StatusCode::UNPROCESSABLE_ENTITY);
        assert!(error.message.contains("SVG"));
        assert!(assert_image_bytes(b"nope", "file").is_err());
    }

    #[test]
    fn random_names_ignore_client_input() {
        let name = random_image_name("user_x", ImageKind::Png);
        assert!(name.starts_with("user_x_"));
        assert!(name.ends_with(".png"));
        assert_eq!(name.len(), "user_x_".len() + 24 + ".png".len());
    }

    fn decode_avatar(url: &str) -> String {
        percent_encoding::percent_decode_str(url.trim_start_matches("data:image/svg+xml;utf8,"))
            .decode_utf8_lossy()
            .into_owned()
    }

    #[test]
    fn avatar_is_generated_locally_from_initials() {
        let url = default_avatar("Ada Lovelace");
        assert!(url.starts_with("data:image/svg+xml;utf8,"));
        let svg = decode_avatar(&url);
        assert!(svg.contains(">AL<"));
        let without_xmlns = svg.replace("xmlns=\"http://www.w3.org/2000/svg\"", "");
        assert!(!without_xmlns.contains("http://"));
        assert!(!without_xmlns.contains("https://"));
    }

    #[test]
    fn avatar_is_stable_and_handles_emails_and_empty_names() {
        assert_eq!(
            default_avatar("grace.hopper@example.com"),
            default_avatar("grace.hopper@example.com")
        );
        assert!(decode_avatar(&default_avatar("grace.hopper@example.com")).contains(">GH<"));
        assert!(decode_avatar(&default_avatar("")).contains(">?<"));
    }

    #[test]
    fn avatar_never_injects_markup() {
        let svg = decode_avatar(&default_avatar("<script>alert(1)</script>"));
        assert!(!svg.contains("<script"));
        assert!(svg.contains(">S</text>"));
    }
}
