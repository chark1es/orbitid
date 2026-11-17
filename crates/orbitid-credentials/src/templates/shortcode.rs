//! The JWT-template shortcode engine (`{{user.first_name}}`), including
//! quoted `||` fallbacks and the initials-avatar generator.

use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use regex::Regex;
use serde_json::{Map, Value};

const PROTOTYPE_KEYS: [&str; 3] = ["__proto__", "constructor", "prototype"];
const AVATAR_TINTS: [&str; 6] = [
    "#d9d4cc", "#cfd3d6", "#d6d0c4", "#c9cfc8", "#d8cfd0", "#cbd0d9",
];

// ───────────── shortcode engine ─────────────

fn split_fallbacks(expression: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let chars: Vec<char> = expression.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        let ch = chars[index];
        if let Some(open) = quote {
            current.push(ch);
            if ch == open {
                quote = None;
            }
            index += 1;
            continue;
        }
        if ch == '\'' || ch == '"' {
            quote = Some(ch);
            current.push(ch);
            index += 1;
            continue;
        }
        if ch == '|' && chars.get(index + 1) == Some(&'|') {
            parts.push(std::mem::take(&mut current));
            index += 2;
            continue;
        }
        current.push(ch);
        index += 1;
    }
    parts.push(current);
    parts
}

fn lookup_path(context: &Value, path: &str) -> Option<Value> {
    let mut current = context;
    for key in path.split('.') {
        if PROTOTYPE_KEYS.contains(&key) {
            return None;
        }
        let Value::Object(map) = current else {
            return None;
        };
        if !map.contains_key(key) {
            return None;
        }
        current = map.get(key)?;
    }
    Some(current.clone())
}

fn resolve_token(token: &str, context: &Value) -> Option<Value> {
    let token = token.trim();
    if token.is_empty() {
        return None;
    }
    let bytes = token.as_bytes();
    let first = bytes[0] as char;
    if (first == '\'' || first == '"') && token.len() >= 2 && token.ends_with(first) {
        return Some(Value::String(token[1..token.len() - 1].to_string()));
    }
    match token {
        "true" => return Some(Value::Bool(true)),
        "false" => return Some(Value::Bool(false)),
        "null" => return Some(Value::Null),
        _ => {}
    }
    if let Some(number) = parse_number(token) {
        return Some(number);
    }
    lookup_path(context, token)
}

fn parse_number(token: &str) -> Option<Value> {
    let valid = Regex::new(r"^-?\d+(\.\d+)?$").ok()?;
    if !valid.is_match(token) {
        return None;
    }
    if let Ok(integer) = token.parse::<i64>() {
        return Some(Value::from(integer));
    }
    let value = token.parse::<f64>().ok()?;
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        return Some(Value::from(value as i64));
    }
    serde_json::Number::from_f64(value).map(Value::Number)
}

fn is_empty(value: &Option<Value>) -> bool {
    match value {
        None | Some(Value::Null) => true,
        Some(Value::String(text)) => text.is_empty(),
        _ => false,
    }
}

fn resolve_expression(expression: &str, context: &Value) -> Option<Value> {
    let mut last = None;
    for part in split_fallbacks(expression) {
        let value = resolve_token(&part, context);
        if !is_empty(&value) {
            return value;
        }
        last = value;
    }
    last
}

/// Renders a shortcode value as a string (`""` for missing values).
pub fn stringify_shortcode_value(value: &Option<Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Bool(value)) => value.to_string(),
        Some(other) => other.to_string(),
    }
}

/// Renders one template string. A string that is exactly one shortcode keeps
/// the resolved JSON type; otherwise shortcodes are interpolated as strings.
pub fn render_template_value(template: &str, context: &Value) -> Option<Value> {
    let whole = Regex::new(r"^\s*\{\{([\s\S]+?)\}\}\s*$").ok()?;
    if let Some(captures) = whole.captures(template) {
        return resolve_expression(
            captures.get(1).map(|m| m.as_str()).unwrap_or_default(),
            context,
        );
    }
    if !template.contains("{{") {
        return Some(Value::String(template.to_string()));
    }
    let interpolation = Regex::new(r"\{\{([\s\S]+?)\}\}").ok()?;
    Some(Value::String(
        interpolation
            .replace_all(template, |captures: &regex::Captures<'_>| {
                let expression = captures.get(1).map(|m| m.as_str()).unwrap_or_default();
                stringify_shortcode_value(&resolve_expression(expression, context))
            })
            .into_owned(),
    ))
}

enum Rendered {
    Value(Value),
    Omit,
}

fn render_deep(value: &Value, context: &Value) -> Rendered {
    match value {
        Value::String(template) => match render_template_value(template, context) {
            Some(rendered) => Rendered::Value(rendered),
            None => Rendered::Omit,
        },
        Value::Array(items) => Rendered::Value(Value::Array(
            items
                .iter()
                .filter_map(|item| match render_deep(item, context) {
                    Rendered::Value(value) => Some(value),
                    Rendered::Omit => None,
                })
                .collect(),
        )),
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, item) in map {
                if PROTOTYPE_KEYS.contains(&key.as_str()) {
                    continue;
                }
                if let Rendered::Value(rendered) = render_deep(item, context) {
                    out.insert(key.clone(), rendered);
                }
            }
            Rendered::Value(Value::Object(out))
        }
        other => Rendered::Value(other.clone()),
    }
}

/// Renders every claim value; claims whose shortcode resolved to nothing are
/// dropped.
pub fn render_claims_with_context(
    claims: &Map<String, Value>,
    context: &Value,
) -> Map<String, Value> {
    match render_deep(&Value::Object(claims.clone()), context) {
        Rendered::Value(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

/// `DEFAULT_AVATAR` from `serializers.ts`: an initials SVG as a data URL.
pub fn default_avatar(seed: &str) -> String {
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
    let local = seed.split('@').next().unwrap_or(seed);
    let words: Vec<&str> = local
        .split(|ch: char| ch.is_whitespace() || matches!(ch, '.' | '_' | '-'))
        .filter(|word| !word.is_empty())
        .collect();
    let mut initials = String::new();
    for word in words {
        if let Some(ch) = word.chars().find(|ch| ch.is_alphanumeric()) {
            initials.extend(ch.to_uppercase());
            if initials.chars().count() >= 2 {
                break;
            }
        }
    }
    if initials.is_empty() {
        initials.push('?');
    }
    let mut hash: u32 = 0;
    for ch in seed.chars() {
        hash = hash.wrapping_mul(31).wrapping_add(ch as u32);
    }
    let tint = AVATAR_TINTS[(hash % AVATAR_TINTS.len() as u32) as usize];
    let svg = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\"><rect width=\"64\" height=\"64\" fill=\"{tint}\"/><text x=\"32\" y=\"32\" dy=\".35em\" text-anchor=\"middle\" font-family=\"Helvetica, Arial, sans-serif\" font-size=\"26\" font-weight=\"600\" fill=\"#2a2623\">{initials}</text></svg>"
    );
    format!(
        "data:image/svg+xml;utf8,{}",
        utf8_percent_encode(&svg, ENCODE)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context() -> Value {
        serde_json::json!({
            "user": {
                "id": "user_1", "username": "ada", "first_name": "Ada", "last_name": "Lovelace",
                "full_name": "Ada Lovelace", "primary_email_address": "ada@example.com",
                "email_verified": true, "created_at": 1_700_000_000_000u64,
                "public_metadata": {"tier": "pro", "team": {"name": "core", "size": 3}, "tags": ["a", "b"]},
                "unsafe_metadata": {}
            },
            "session": {"id": "sess_1"},
            "org": {"id": "org_1", "slug": "acme", "role": "org:admin", "permissions": ["org:sys_profile:manage"]},
            "org_membership": {"role": "org:admin", "permissions": ["org:sys_profile:manage"]}
        })
    }

    #[test]
    fn keeps_json_types_for_single_shortcodes() {
        let context = context();
        assert_eq!(
            render_template_value("{{user.created_at}}", &context),
            Some(Value::from(1_700_000_000_000i64))
        );
        assert_eq!(
            render_template_value("{{user.email_verified}}", &context),
            Some(Value::Bool(true))
        );
        assert_eq!(
            render_template_value("  {{user.id}}  ", &context),
            Some(Value::String("user_1".into()))
        );
        assert_eq!(
            render_template_value("{{user.public_metadata.tags}}", &context),
            Some(serde_json::json!(["a", "b"]))
        );
    }

    #[test]
    fn interpolates_and_drops_missing_values() {
        let context = context();
        assert_eq!(
            render_template_value(
                "{{user.first_name}} <{{user.primary_email_address}}>",
                &context
            ),
            Some(Value::String("Ada <ada@example.com>".into()))
        );
        assert_eq!(
            render_template_value("hi {{user.nope}}!", &context),
            Some(Value::String("hi !".into()))
        );
        assert_eq!(
            render_template_value("meta={{user.public_metadata.team}}", &context),
            Some(Value::String("meta={\"name\":\"core\",\"size\":3}".into()))
        );
        assert_eq!(render_template_value("{{user.nope}}", &context), None);
    }

    #[test]
    fn resolves_quoted_fallbacks() {
        let context = context();
        assert_eq!(
            render_template_value("{{user.nope || user.username}}", &context),
            Some(Value::String("ada".into()))
        );
        assert_eq!(
            render_template_value("{{user.nope || 'a||b'}}", &context),
            Some(Value::String("a||b".into()))
        );
        assert_eq!(
            render_template_value("{{user.email_verified || false}}", &context),
            Some(Value::Bool(true))
        );
    }

    #[test]
    fn drops_claims_that_resolve_to_nothing() {
        let context = context();
        let claims = serde_json::json!({
            "a": "{{user.nope}}", "b": "{{user.id}}", "c": 5,
            "d": {"e": "{{user.nope}}", "f": "{{user.username}}"}
        });
        let rendered = render_claims_with_context(claims.as_object().unwrap(), &context);
        assert_eq!(
            Value::Object(rendered),
            serde_json::json!({"b": "user_1", "c": 5, "d": {"f": "ada"}})
        );
    }

    #[test]
    fn avatar_is_an_encoded_svg() {
        let url = default_avatar("ada@example.com");
        assert!(url.starts_with("data:image/svg+xml;utf8,"));
        assert!(url.contains("A"));
    }
}
