//! Recovery-factor resolution shared by password reset flows.

use orbitid_core::error::Result;
use orbitid_core::models::{UserRow, VerificationRow};
use orbitid_core::state::AppState;
use orbitid_identity::users::{list_emails, list_phones};

#[derive(Debug, Clone)]
pub struct RecoveryFactor {
    pub strategy: String,
    pub email_id: Option<String>,
    pub phone_id: Option<String>,
}

/// Maps a verified `reset_password` record to the recovery factor it authorized.
/// The record is authoritative for the channel and identifier.
pub async fn recovery_factor_from_verification(
    state: &AppState,
    user: &UserRow,
    verification: &VerificationRow,
) -> Result<Option<RecoveryFactor>> {
    if verification.strategy == "email_code" {
        let email = list_emails(state, &user.id)
            .await?
            .into_iter()
            .find(|email| email.email == verification.identifier && email.verified);
        return Ok(email.map(|email| RecoveryFactor {
            strategy: "reset_password_email_code".into(),
            email_id: Some(email.id),
            phone_id: None,
        }));
    }
    if verification.strategy == "phone_code" {
        let phone = list_phones(state, &user.id)
            .await?
            .into_iter()
            .find(|phone| phone.phone == verification.identifier && phone.verified);
        return Ok(phone.map(|phone| RecoveryFactor {
            strategy: "reset_password_phone_code".into(),
            email_id: None,
            phone_id: Some(phone.id),
        }));
    }
    Ok(None)
}
