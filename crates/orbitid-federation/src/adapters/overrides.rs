//! Test seam: replace a provider adapter with an in-process fake.

#[cfg(any(test, feature = "test-util"))]
mod registry {
    use std::collections::HashMap;
    use std::sync::{Arc, OnceLock, RwLock};

    use orbitid_core::AppState;

    use crate::config::OAuthProviderConfig;
    use crate::oauth::OAuthAdapter;

    /// Test seam replacing a provider's adapter (a fake provider in-process).
    pub type AdapterFactory = Arc<
        dyn Fn(
                &OAuthProviderConfig,
                &str,
                &AppState,
            ) -> Result<Box<dyn OAuthAdapter>, orbitid_core::OrbitError>
            + Send
            + Sync,
    >;

    fn registry() -> &'static RwLock<HashMap<String, AdapterFactory>> {
        static REGISTRY: OnceLock<RwLock<HashMap<String, AdapterFactory>>> = OnceLock::new();
        REGISTRY.get_or_init(|| RwLock::new(HashMap::new()))
    }

    /// Registers a provider adapter for tests.
    pub fn register_adapter_override(key: &str, factory: AdapterFactory) {
        if let Ok(mut guard) = registry().write() {
            guard.insert(key.to_string(), factory);
        }
    }

    pub fn adapter_override(key: &str) -> Option<AdapterFactory> {
        registry()
            .read()
            .ok()
            .and_then(|guard| guard.get(key).cloned())
    }

    /// Forgets every override (tests change providers between cases).
    pub fn reset_adapter_overrides() {
        if let Ok(mut guard) = registry().write() {
            guard.clear();
        }
    }
}

#[cfg(any(test, feature = "test-util"))]
pub use registry::{
    adapter_override, register_adapter_override, reset_adapter_overrides, AdapterFactory,
};
