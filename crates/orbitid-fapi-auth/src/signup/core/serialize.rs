//! Sign-up field/verification serialization and requirement computation.

use orbitid_core::error::{error_codes, Result};
use orbitid_core::models::SignUpRow;
use orbitid_core::resources::{
    Metadata, SignUpJson, SignUpStatus, SignUpVerificationsJson, VerificationErrorJson,
    VerificationJson, VerificationStatus,
};
use orbitid_core::state::AppState;
use orbitid_identity::verifications::{get_verification_by_id, verification_json};

use crate::state::{SignUpFields, SignUpVerifications, VerificationSnapshot};

pub fn metadata_object(value: &serde_json::Value) -> Metadata {
    match value {
        serde_json::Value::Object(map) => map.clone(),
        _ => Metadata::new(),
    }
}

pub fn as_sign_up_fields(row: &SignUpRow) -> SignUpFields {
    SignUpFields::from_json(&row.fields.0)
}

pub fn as_sign_up_verifications(row: &SignUpRow) -> SignUpVerifications {
    SignUpVerifications::from_json(&row.verifications.0)
}

/// `snapshotJSON`: the verification resource for one sign-up field.
pub async fn snapshot_json(
    state: &AppState,
    snapshot: Option<&VerificationSnapshot>,
) -> Result<Option<VerificationJson>> {
    let Some(snapshot) = snapshot else {
        return Ok(None);
    };
    if let Some(id) = &snapshot.verification_id {
        let row = get_verification_by_id(state, id).await?;
        if let Some(mut json) = verification_json(row.as_ref(), None) {
            json.strategy = snapshot.strategy.clone();
            return Ok(Some(json));
        }
    }
    Ok(Some(VerificationJson {
        status: match snapshot.status.as_str() {
            "verified" => VerificationStatus::Verified,
            "transferable" => VerificationStatus::Transferable,
            "failed" => VerificationStatus::Failed,
            "expired" => VerificationStatus::Expired,
            _ => VerificationStatus::Unverified,
        },
        strategy: snapshot.strategy.clone(),
        attempts: snapshot.attempts,
        expire_at: snapshot.expire_at,
        external_verification_redirect_url: snapshot.external_verification_redirect_url.clone(),
        error: (snapshot.status == "expired").then(|| VerificationErrorJson {
            code: error_codes::VERIFICATION_EXPIRED.into(),
            message: "Verification expired".into(),
        }),
        nonce: None,
    }))
}

pub(super) fn verification_strategy_for(provider: &str) -> String {
    if provider.starts_with("enterprise_") {
        "enterprise_sso".to_string()
    } else {
        format!("from_oauth_{provider}")
    }
}

pub fn email_is_verified(fields: &SignUpFields, verifications: &SignUpVerifications) -> bool {
    let Some(snapshot) = &verifications.email_address else {
        return false;
    };
    snapshot.status == "verified"
        && fields.email_address.is_some()
        && snapshot.identifier.as_deref() == fields.email_address.as_deref()
}

pub fn phone_is_verified(fields: &SignUpFields, verifications: &SignUpVerifications) -> bool {
    let Some(snapshot) = &verifications.phone_number else {
        return false;
    };
    snapshot.status == "verified"
        && fields.phone_number.is_some()
        && snapshot.identifier.as_deref() == fields.phone_number.as_deref()
}

#[derive(Debug, Clone, Default)]
pub struct SignUpRequirements {
    pub required_fields: Vec<String>,
    pub optional_fields: Vec<String>,
    pub missing_fields: Vec<String>,
    pub unverified_fields: Vec<String>,
}

/// Computes required/optional/missing/unverified field lists from settings.
pub fn compute_requirements(
    state: &AppState,
    fields: &SignUpFields,
    verifications: &SignUpVerifications,
) -> SignUpRequirements {
    let settings = state.settings.get();
    let attributes = &settings.attributes;
    let mut required = Vec::new();
    let mut optional = Vec::new();
    let mut missing = Vec::new();
    let mut unverified = Vec::new();
    if settings.sign_up.legal_consent_required {
        required.push("legal_accepted".to_string());
        if fields.legal_accepted_at.is_none() {
            missing.push("legal_accepted".to_string());
        }
    }
    for (kind, attr) in [
        ("email_address", &attributes.email_address),
        ("phone_number", &attributes.phone_number),
        ("username", &attributes.username),
        ("first_name", &attributes.first_name),
        ("last_name", &attributes.last_name),
        ("password", &attributes.password),
    ] {
        if !attr.enabled {
            continue;
        }
        if attr.required {
            required.push(kind.to_string());
        } else {
            optional.push(kind.to_string());
        }
        let value = fields.value_of(kind);
        let present = value.map(|value| !value.trim().is_empty()).unwrap_or(false);
        if attr.required && !present {
            missing.push(kind.to_string());
            continue;
        }
        if !present {
            continue;
        }
        if kind != "email_address" && kind != "phone_number" {
            continue;
        }
        if !attr.verify_at_sign_up {
            continue;
        }
        let verified = if kind == "email_address" {
            email_is_verified(fields, verifications)
        } else {
            phone_is_verified(fields, verifications)
        };
        if !verified {
            unverified.push(kind.to_string());
        }
    }
    let _ = required.len();
    SignUpRequirements {
        required_fields: required,
        optional_fields: optional,
        missing_fields: missing,
        unverified_fields: unverified,
    }
}

fn parse_status(value: &str) -> SignUpStatus {
    match value {
        "complete" => SignUpStatus::Complete,
        "abandoned" => SignUpStatus::Abandoned,
        _ => SignUpStatus::MissingRequirements,
    }
}

/// `buildSignUpJSON`.
pub async fn build_sign_up_json(state: &AppState, row: &SignUpRow) -> Result<SignUpJson> {
    let fields = as_sign_up_fields(row);
    let verifications = as_sign_up_verifications(row);
    let requirements = compute_requirements(state, &fields, &verifications);
    let public_metadata: Metadata = Metadata::new();
    Ok(SignUpJson {
        object: "sign_up".into(),
        id: row.id.clone(),
        status: parse_status(&row.status),
        required_fields: requirements.required_fields,
        optional_fields: requirements.optional_fields,
        missing_fields: requirements.missing_fields,
        unverified_fields: requirements.unverified_fields,
        verifications: SignUpVerificationsJson {
            email_address: snapshot_json(state, verifications.email_address.as_ref()).await?,
            phone_number: snapshot_json(state, verifications.phone_number.as_ref()).await?,
            external_account: snapshot_json(state, verifications.external_account.as_ref()).await?,
            web3_wallet: snapshot_json(state, verifications.web3_wallet.as_ref()).await?,
        },
        username: fields.username.clone(),
        email_address: fields.email_address.clone(),
        phone_number: fields.phone_number.clone(),
        first_name: fields.first_name.clone(),
        last_name: fields.last_name.clone(),
        password_enabled: fields.password_hash.is_some(),
        unsafe_metadata: metadata_object(&row.unsafe_metadata.0),
        public_metadata,
        custom_action: false,
        external_id: fields.external_id.clone(),
        created_session_id: row.created_session_id.clone(),
        created_user_id: row.created_user_id.clone(),
        abandon_at: row.abandon_at,
        legal_accepted_at: fields.legal_accepted_at,
    })
}
