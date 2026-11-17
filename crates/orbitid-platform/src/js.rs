//! Small helpers that reproduce the exact JavaScript string/number semantics the
//! TypeScript server relied on (initial-capital-free, but byte-for-byte on the wire).
//!
//! Only the few primitives the platform services need live here: `String(value)`,
//! JS truthiness, control-character stripping and `encodeURIComponent`.

use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use serde_json::Value;

/// The characters `encodeURIComponent` leaves unescaped (`A-Za-z0-9-_.!~*'()`).
const ENCODE_URI_COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

/// `encodeURIComponent(value)`.
pub fn encode_uri_component(value: &str) -> String {
    utf8_percent_encode(value, ENCODE_URI_COMPONENT).to_string()
}

/// `String(value)` for the JSON scalar types email variables use.
pub fn string_of(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Null => "null".to_string(),
        other => other.to_string(),
    }
}

/// JavaScript truthiness for JSON values.
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|value| value != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(map) => !map.is_empty(),
    }
}

/// `value.replace(/[\r\n]+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "")`.
pub fn strip_line_breaks_and_controls(value: &str) -> String {
    let mut collapsed = String::with_capacity(value.len());
    let mut previous_was_break = false;
    for character in value.chars() {
        if character == '\r' || character == '\n' {
            if !previous_was_break {
                collapsed.push(' ');
            }
            previous_was_break = true;
        } else {
            previous_was_break = false;
            collapsed.push(character);
        }
    }
    collapsed
        .chars()
        .filter(|character| {
            let code = *character as u32;
            !(code <= 0x1f || code == 0x7f)
        })
        .collect()
}

/// `value.replace(/[\r\n\t]+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "").trim()`.
pub fn flatten_whitespace(value: &str) -> String {
    let mut collapsed = String::with_capacity(value.len());
    let mut previous_was_space = false;
    for character in value.chars() {
        if character == '\r' || character == '\n' || character == '\t' {
            if !previous_was_space {
                collapsed.push(' ');
            }
            previous_was_space = true;
        } else {
            previous_was_space = false;
            collapsed.push(character);
        }
    }
    let cleaned: String = collapsed
        .chars()
        .filter(|character| {
            let code = *character as u32;
            !(code <= 0x1f || code == 0x7f)
        })
        .collect();
    cleaned.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn encodes_like_encode_uri_component() {
        assert_eq!(encode_uri_component("a b/c?d=e&f"), "a%20b%2Fc%3Fd%3De%26f");
        assert_eq!(encode_uri_component("-_.!~*'()"), "-_.!~*'()");
        assert_eq!(encode_uri_component("é"), "%C3%A9");
    }

    #[test]
    fn collapses_line_breaks_and_controls() {
        assert_eq!(
            strip_line_breaks_and_controls("Ada\r\nBcc: x\u{0}\u{1f}\u{7f}"),
            "Ada Bcc: x"
        );
        assert_eq!(flatten_whitespace(" a\t\tb\r\n c "), "a b  c");
    }

    #[test]
    fn truthiness_matches_javascript() {
        assert!(!truthy(&json!("")));
        assert!(!truthy(&json!(0)));
        assert!(!truthy(&Value::Null));
        assert!(truthy(&json!("x")));
        assert!(truthy(&json!(2)));
    }
}
