use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AttributeConfig {
    /// Required by the zod schema when the attribute object is present.
    pub enabled: bool,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub used_for_first_factor: bool,
    #[serde(default)]
    pub used_for_second_factor: bool,
    #[serde(default)]
    pub verifications: Vec<String>,
    #[serde(default = "default_true")]
    pub verify_at_sign_up: bool,
}

fn default_true() -> bool {
    true
}

impl Default for AttributeConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            required: false,
            used_for_first_factor: false,
            used_for_second_factor: false,
            verifications: Vec::new(),
            verify_at_sign_up: true,
        }
    }
}

impl AttributeConfig {
    fn attribute(
        enabled: bool,
        required: bool,
        used_for_first_factor: bool,
        used_for_second_factor: bool,
        verifications: &[&str],
        verify_at_sign_up: bool,
    ) -> Self {
        Self {
            enabled,
            required,
            used_for_first_factor,
            used_for_second_factor,
            verifications: verifications.iter().map(|s| s.to_string()).collect(),
            verify_at_sign_up,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AttributesSettings {
    #[serde(default = "default_email_attribute")]
    pub email_address: AttributeConfig,
    #[serde(default = "default_phone_attribute")]
    pub phone_number: AttributeConfig,
    #[serde(default = "default_username_attribute")]
    pub username: AttributeConfig,
    #[serde(default = "default_first_name_attribute")]
    pub first_name: AttributeConfig,
    #[serde(default = "default_last_name_attribute")]
    pub last_name: AttributeConfig,
    #[serde(default = "default_password_attribute")]
    pub password: AttributeConfig,
    #[serde(default = "default_passkey_attribute")]
    pub passkey: AttributeConfig,
    #[serde(default = "default_backup_code_attribute")]
    pub backup_code: AttributeConfig,
    #[serde(default = "default_authenticator_app_attribute")]
    pub authenticator_app: AttributeConfig,
}

fn default_email_attribute() -> AttributeConfig {
    AttributeConfig::attribute(true, true, true, false, &["email_code"], true)
}
fn default_phone_attribute() -> AttributeConfig {
    AttributeConfig::attribute(false, false, false, false, &["phone_code"], true)
}
fn default_username_attribute() -> AttributeConfig {
    AttributeConfig::attribute(false, false, true, false, &[], false)
}
fn default_first_name_attribute() -> AttributeConfig {
    AttributeConfig::attribute(true, false, false, false, &[], false)
}
fn default_last_name_attribute() -> AttributeConfig {
    AttributeConfig::attribute(true, false, false, false, &[], false)
}
fn default_password_attribute() -> AttributeConfig {
    AttributeConfig::attribute(true, true, true, false, &[], false)
}
fn default_passkey_attribute() -> AttributeConfig {
    AttributeConfig::attribute(false, false, true, false, &[], false)
}
fn default_backup_code_attribute() -> AttributeConfig {
    AttributeConfig::attribute(false, false, false, true, &[], true)
}
fn default_authenticator_app_attribute() -> AttributeConfig {
    AttributeConfig::attribute(false, false, false, true, &[], true)
}

impl Default for AttributesSettings {
    fn default() -> Self {
        Self {
            email_address: default_email_attribute(),
            phone_number: default_phone_attribute(),
            username: default_username_attribute(),
            first_name: default_first_name_attribute(),
            last_name: default_last_name_attribute(),
            password: default_password_attribute(),
            passkey: default_passkey_attribute(),
            backup_code: default_backup_code_attribute(),
            authenticator_app: default_authenticator_app_attribute(),
        }
    }
}
