//! Instance settings: schema, policy, store, and the public environment projection.

pub mod environment;
pub mod policy;
pub mod store;
pub mod types;

pub use environment::{build_environment, EnvironmentJson, SocialProviderSummary};
pub use policy::{
    assert_settings_usable, effective_email_provider, email_delivery_required, normalize_settings,
    sms_delivery_required, DeliveryEnvironment,
};
#[cfg(feature = "test-util")]
pub use store::create_settings_store_without_refresher;
pub use store::{
    create_settings_store, deep_merge, migrate_stored_settings, SettingsStore,
    SettingsStoreOptions, CURRENT_SETTINGS_VERSION, SETTINGS_VERSION_KEY,
};
pub use types::*;
