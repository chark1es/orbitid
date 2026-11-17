use serde::Deserialize;
use serde_json::Value;

/// Accepts JSON booleans plus urlencoded `"true"`/`"false"`/`"1"`/`"0"`.
pub fn deserialize_bool<'de, D>(deserializer: D) -> std::result::Result<bool, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    value_to_bool(&value).ok_or_else(|| serde::de::Error::custom("expected a boolean"))
}

fn value_to_bool(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(value) => Some(*value),
        Value::String(text) => match text.as_str() {
            "true" | "1" => Some(true),
            "false" | "0" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

/// Like [`deserialize_bool`] but `null` and absence both mean `None`.
pub fn deserialize_opt_bool<'de, D>(deserializer: D) -> std::result::Result<Option<bool>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    if value.is_null() {
        return Ok(None);
    }
    value_to_bool(&value)
        .map(Some)
        .ok_or_else(|| serde::de::Error::custom("expected a boolean"))
}

/// `z.coerce.number().int()`: a JSON number or a numeric string.
pub fn deserialize_opt_int<'de, D>(deserializer: D) -> std::result::Result<Option<i64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    if value.is_null() {
        return Ok(None);
    }
    match &value {
        Value::Number(number) => {
            if let Some(int) = number.as_i64() {
                return Ok(Some(int));
            }
            number
                .as_f64()
                .filter(|float| float.fract() == 0.0)
                .map(|float| float as i64)
                .map(Some)
                .ok_or_else(|| serde::de::Error::custom("expected an integer"))
        }
        Value::String(text) => {
            let trimmed = text.trim();
            trimmed
                .parse::<i64>()
                .map(Some)
                .map_err(|_| serde::de::Error::custom("expected an integer"))
        }
        _ => Err(serde::de::Error::custom("expected an integer")),
    }
}

/// `T | null | undefined`: absence means `None`, an explicit `null` means
/// `Some(None)` (clear the column) and a value means `Some(Some(value))`.
pub fn deserialize_opt_nullable_string<'de, D>(
    deserializer: D,
) -> std::result::Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    match value {
        Value::Null => Ok(Some(None)),
        Value::String(text) => Ok(Some(Some(text))),
        _ => Err(serde::de::Error::custom("expected a string or null")),
    }
}

/// Like [`deserialize_opt_nullable_string`] for `string[]`.
pub fn deserialize_opt_nullable_string_list<'de, D>(
    deserializer: D,
) -> std::result::Result<Option<Option<Vec<String>>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    match value {
        Value::Null => Ok(Some(None)),
        Value::Array(items) => items
            .into_iter()
            .map(|item| match item {
                Value::String(text) => Ok(text),
                _ => Err(serde::de::Error::custom("expected a list of strings")),
            })
            .collect::<std::result::Result<Vec<_>, _>>()
            .map(|items| Some(Some(items))),
        _ => Err(serde::de::Error::custom(
            "expected a list of strings or null",
        )),
    }
}

/// `z.preprocess(string → [string], z.array(z.string()).max(20).optional())`.
pub fn deserialize_opt_string_list<'de, D>(
    deserializer: D,
) -> std::result::Result<Option<Vec<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    if value.is_null() {
        return Ok(None);
    }
    let items = match value {
        Value::String(text) => vec![Value::String(text)],
        Value::Array(items) => items,
        _ => return Err(serde::de::Error::custom("expected a list of strings")),
    };
    if items.len() > 20 {
        return Err(serde::de::Error::custom("at most 20 values are allowed"));
    }
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        match item {
            Value::String(text) => out.push(text),
            _ => return Err(serde::de::Error::custom("expected a list of strings")),
        }
    }
    Ok(Some(out))
}
