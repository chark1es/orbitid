//! Built-in social provider adapters, reproducing what `arctic` does for each
//! provider in the TypeScript server (2.3.x semantics).
//!
//! Authorization URLs, token-exchange bodies, client authentication style and
//! PKCE usage are per provider; the profile shapes live in
//! [`crate::profiles`] and [`crate::fetch`].

mod impls;
#[cfg(any(test, feature = "test-util"))]
mod overrides;
mod table;

pub use impls::{GenericAdapter, SocialAdapter, TikTokAdapter};
pub use table::{pkce_challenge, BuiltInProvider, ClientAuth};

#[cfg(any(test, feature = "test-util"))]
pub use overrides::{
    adapter_override, register_adapter_override, reset_adapter_overrides, AdapterFactory,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_matches_rfc7636_example() {
        // RFC 7636 appendix B.
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn the_provider_table_covers_every_switch_arm() {
        for key in [
            "google",
            "github",
            "gitlab",
            "discord",
            "microsoft",
            "facebook",
            "twitter",
            "x",
            "slack",
            "twitch",
            "spotify",
            "bitbucket",
            "dropbox",
            "notion",
            "box",
            "coinbase",
            "line",
            "linear",
            "atlassian",
        ] {
            assert!(BuiltInProvider::from_key(key).is_some(), "{key}");
        }
        assert!(BuiltInProvider::from_key("apple").is_none());
        assert!(BuiltInProvider::from_key("custom_x").is_none());
    }

    #[test]
    fn pkce_is_used_by_exactly_the_providers_arctic_uses_it_for() {
        for key in ["google", "microsoft", "twitter", "x", "line"] {
            assert!(BuiltInProvider::from_key(key).unwrap().pkce, "{key}");
        }
        for key in [
            "github",
            "gitlab",
            "discord",
            "facebook",
            "slack",
            "bitbucket",
        ] {
            assert!(!BuiltInProvider::from_key(key).unwrap().pkce, "{key}");
        }
    }

    #[test]
    fn notion_omits_scope_and_adds_owner() {
        let notion = BuiltInProvider::from_key("notion").unwrap();
        assert!(!notion.include_scope);
        assert_eq!(notion.extra, &[("owner", "user")]);
        let atlassian = BuiltInProvider::from_key("atlassian").unwrap();
        assert_eq!(
            atlassian.extra,
            &[("audience", "api.atlassian.com"), ("prompt", "consent")]
        );
    }
}
