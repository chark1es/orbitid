//! Request-body field types that preserve the TypeScript schemas' semantics.

use serde::de::{self, Deserializer};
use serde::Deserialize;

/// A field that distinguishes "absent" from "explicitly null": zod's
/// `z.string().nullish()`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum NullableString {
    #[default]
    Missing,
    Null,
    Value(String),
}

impl<'de> Deserialize<'de> for NullableString {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        // `#[serde(default)]` fills `Missing` before this runs; `null` reaches
        // `Option::deserialize` as `None`.
        Ok(match Option::<String>::deserialize(deserializer)? {
            None => Self::Null,
            Some(value) => Self::Value(value),
        })
    }
}

impl NullableString {
    /// `None` when the field was absent.
    pub fn as_option(&self) -> Option<Option<&str>> {
        match self {
            Self::Missing => None,
            Self::Null => Some(None),
            Self::Value(value) => Some(Some(value)),
        }
    }

    pub fn is_present(&self) -> bool {
        !matches!(self, Self::Missing)
    }
}

/// `zBool`: accepts a JSON boolean or the form values `true/false/1/0`.
fn bool_from_value<E: de::Error>(value: serde_json::Value) -> Result<bool, E> {
    match value {
        serde_json::Value::Bool(value) => Ok(value),
        serde_json::Value::String(value) => match value.as_str() {
            "true" | "1" => Ok(true),
            "false" | "0" => Ok(false),
            other => Err(E::custom(format!("invalid boolean: {other}"))),
        },
        _ => Err(E::custom("expected a boolean")),
    }
}

/// An optional boolean with `zBool` coercion.
pub fn deserialize_opt_bool<'de, D>(deserializer: D) -> Result<Option<bool>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    value.map(bool_from_value).transpose()
}

/// A required boolean with `zBool` coercion.
pub fn deserialize_bool<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: Deserializer<'de>,
{
    bool_from_value(serde_json::Value::deserialize(deserializer)?)
}
