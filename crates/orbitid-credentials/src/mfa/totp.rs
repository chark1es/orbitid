//! TOTP generation and verification (`otplib` compatible) plus the QR PNG.

use std::io::Cursor;

use base64::Engine;
use hmac::{Hmac, Mac};
use image::ImageFormat;
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use rand::RngCore;
use sha1::Sha1;

use orbitid_core::error::{OrbitError, Result};
use orbitid_core::http::now;

const STEP_SECONDS: i64 = 30;
const WINDOW: i64 = 1;
const DIGITS: u32 = 6;
const SECRET_BYTES: usize = 20;

fn base32_alphabet() -> base32::Alphabet {
    base32::Alphabet::Rfc4648 { padding: false }
}

/// 20 random bytes as upper-case base32 without padding (`otplib` format).
pub fn generate_totp_secret() -> String {
    let mut bytes = [0u8; SECRET_BYTES];
    rand::rng().fill_bytes(&mut bytes);
    base32::encode(base32_alphabet(), &bytes)
}

fn decode_secret(secret: &str) -> Option<Vec<u8>> {
    let normalized: String = secret
        .chars()
        .filter(|ch| !ch.is_whitespace() && *ch != '=')
        .collect::<String>()
        .to_ascii_uppercase();
    base32::decode(base32_alphabet(), &normalized)
}

/// The TOTP code for a specific unix time. Exposed for deterministic tests.
pub fn totp_code_at(secret: &str, unix_seconds: i64) -> Option<String> {
    let key = decode_secret(secret)?;
    let counter = (unix_seconds / STEP_SECONDS) as u64;
    let mut mac = Hmac::<Sha1>::new_from_slice(&key).ok()?;
    mac.update(&counter.to_be_bytes());
    let digest = mac.finalize().into_bytes();
    if digest.len() < 20 {
        return None;
    }
    let offset = (digest[19] & 0x0f) as usize;
    let binary = ((digest[offset] & 0x7f) as u32) << 24
        | (digest[offset + 1] as u32) << 16
        | (digest[offset + 2] as u32) << 8
        | digest[offset + 3] as u32;
    Some(format!(
        "{:0width$}",
        binary % 10u32.pow(DIGITS),
        width = DIGITS as usize
    ))
}

fn normalize_code(code: &str) -> String {
    code.chars().filter(|ch| !ch.is_whitespace()).collect()
}

/// The time step (unix seconds / 30) whose code matches, if any. Higher-level
/// callers persist this to reject replays within the ±1 step window.
pub fn totp_matching_step(secret: &str, code: &str, unix_seconds: i64) -> Option<i64> {
    let code = normalize_code(code);
    if code.len() != DIGITS as usize || !code.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    let current = unix_seconds / STEP_SECONDS;
    (-WINDOW..=WINDOW).find_map(|offset| {
        let step = current + offset;
        totp_code_at(secret, step * STEP_SECONDS)
            .filter(|expected| expected == &code)
            .map(|_| step)
    })
}

/// Verifies a code with the ±1 step window used by `authenticator.options`.
pub fn verify_totp_code_at(secret: &str, code: &str, unix_seconds: i64) -> bool {
    totp_matching_step(secret, code, unix_seconds).is_some()
}

/// Verifies a TOTP code against a freshly scanned secret.
pub fn check_totp_against_secret(secret: &str, code: &str) -> bool {
    verify_totp_code_at(secret, code, now() / 1000)
}

fn encode_component(value: &str) -> String {
    const ENCODE: &AsciiSet = &NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'_')
        .remove(b'.')
        .remove(b'!')
        .remove(b'~')
        .remove(b'*')
        .remove(b'\'')
        .remove(b'(')
        .remove(b')');
    utf8_percent_encode(value, ENCODE).to_string()
}

/// `otplib` `authenticator.keyuri`: includes period, digits and algorithm.
pub fn totp_uri(secret: &str, account_name: &str, issuer: &str) -> String {
    format!(
        "otpauth://totp/{}:{}?secret={}&period={}&digits={}&algorithm=SHA1&issuer={}",
        encode_component(issuer),
        encode_component(account_name),
        secret,
        STEP_SECONDS,
        DIGITS,
        encode_component(issuer),
    )
}

/// PNG data URL, 220 px wide with a one-module quiet zone like `qrcode.toDataURL`.
pub fn qr_code_data_url(uri: &str) -> Result<String> {
    let code = qrcode::QrCode::new(uri.as_bytes())
        .map_err(|error| OrbitError::internal(format!("Could not render QR code: {error}")))?;
    let modules = code.width();
    let colors = code.to_colors();
    let margin_modules = 1usize;
    let target = 220usize;
    let symbol_modules = modules + margin_modules * 2;
    let scale = target as f64 / symbol_modules as f64;
    let symbol = ((symbol_modules as f64) * scale).floor() as u32;
    let margin = margin_modules as f64 * scale;
    let dark = qrcode::types::Color::Dark;
    let image = image::RgbaImage::from_fn(symbol, symbol, |x, y| {
        let fx = x as f64;
        let fy = y as f64;
        let inside = fx >= margin
            && fy >= margin
            && fx < symbol as f64 - margin
            && fy < symbol as f64 - margin;
        let is_dark = if inside {
            let sx = ((fx - margin) / scale) as usize;
            let sy = ((fy - margin) / scale) as usize;
            colors
                .get(sy * modules + sx)
                .is_some_and(|color| *color == dark)
        } else {
            false
        };
        if is_dark {
            image::Rgba([0, 0, 0, 255])
        } else {
            image::Rgba([255, 255, 255, 255])
        }
    });
    let mut buffer = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image)
        .write_to(&mut buffer, ImageFormat::Png)
        .map_err(|error| OrbitError::internal(format!("Could not encode QR PNG: {error}")))?;
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(buffer.into_inner())
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_are_base32_and_round_trip() {
        let secret = generate_totp_secret();
        assert_eq!(secret.len(), 32);
        assert!(secret
            .chars()
            .all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit()));
        assert!(decode_secret(&secret).is_some());
    }

    #[test]
    fn totp_matches_the_rfc6238_vector() {
        let secret = base32::encode(base32_alphabet(), b"12345678901234567890");
        assert_eq!(totp_code_at(&secret, 59).unwrap(), "287082");
        assert_eq!(totp_code_at(&secret, 1_111_111_109).unwrap(), "081804");
    }

    #[test]
    fn totp_accepts_one_step_of_drift() {
        let secret = base32::encode(base32_alphabet(), b"12345678901234567890");
        let code = totp_code_at(&secret, 1_111_111_111).unwrap();
        assert!(verify_totp_code_at(&secret, &code, 1_111_111_111 + 30));
        assert!(verify_totp_code_at(&secret, &code, 1_111_111_111 - 30));
        assert!(!verify_totp_code_at(&secret, &code, 1_111_111_111 + 90));
    }

    #[test]
    fn qr_codes_are_png_data_urls() {
        let url = qr_code_data_url("otpauth://totp/test").unwrap();
        assert!(url.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn uri_contains_every_otplib_parameter() {
        let uri = totp_uri("SECRET", "ada@example.com", "OrbitID App");
        assert_eq!(
            uri,
            "otpauth://totp/OrbitID%20App:ada%40example.com?secret=SECRET&period=30&digits=6&algorithm=SHA1&issuer=OrbitID%20App"
        );
    }
}
