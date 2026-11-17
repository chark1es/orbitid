use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::resources::Metadata;
use serde_json::{json, Value};

/// A bounded metadata blob: at most 100 keys, 256-char keys, 4 KB strings,
/// 16 KB overall (`metadataSchema`).
pub fn validate_metadata(metadata: &Metadata) -> Result<()> {
    if metadata.len() > 100 {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "metadata may contain at most 100 keys",
        )
        .with_meta(json!({ "param_name": "metadata" })));
    }
    for (key, value) in metadata {
        if key.chars().count() > 256 {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_PARAM_FORMAT_INVALID,
                "metadata: keys may be at most 256 characters",
            )
            .with_meta(json!({ "param_name": "metadata" })));
        }
        validate_metadata_value(value)?;
    }
    let size = serde_json::to_string(metadata)
        .map(|text| text.chars().count())
        .unwrap_or(usize::MAX);
    if size > 16 * 1024 {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "metadata must serialize to at most 16 KB",
        )
        .with_meta(json!({ "param_name": "metadata" })));
    }
    Ok(())
}

fn validate_metadata_value(value: &Value) -> Result<()> {
    match value {
        Value::String(text) if text.chars().count() > 4096 => Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "metadata: string values may be at most 4096 characters",
        )
        .with_meta(json!({ "param_name": "metadata" }))),
        Value::Array(items) => {
            if items.len() > 100 {
                return Err(OrbitError::unprocessable(
                    error_codes::FORM_PARAM_FORMAT_INVALID,
                    "metadata: arrays may contain at most 100 items",
                )
                .with_meta(json!({ "param_name": "metadata" })));
            }
            for item in items {
                validate_metadata_value(item)?;
            }
            Ok(())
        }
        Value::Object(map) => {
            for (key, item) in map {
                if key.chars().count() > 256 {
                    return Err(OrbitError::unprocessable(
                        error_codes::FORM_PARAM_FORMAT_INVALID,
                        "metadata: keys may be at most 256 characters",
                    )
                    .with_meta(json!({ "param_name": "metadata" })));
                }
                validate_metadata_value(item)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Builds an empty metadata object from an optional body field.
pub fn metadata_or_empty(value: Option<Metadata>) -> Metadata {
    value.unwrap_or_default()
}

// ───────────── SQL filters ─────────────
