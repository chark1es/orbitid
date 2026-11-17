//! ID generation, ported from the retired TypeScript server.
//!
//! `newId("user")` → `user_2AbC...`: 27 characters from the same 62-character
//! alphabet nanoid uses in the TypeScript server.

/// ID prefixes, from `ID_PREFIX` in `packages/shared/src/keys.ts`.
pub mod id_prefix {
    pub const USER: &str = "user";
    pub const SESSION: &str = "sess";
    pub const CLIENT: &str = "client";
    pub const SIGN_IN: &str = "sia";
    pub const SIGN_UP: &str = "sua";
    pub const EMAIL: &str = "idn_e";
    pub const PHONE: &str = "idn_p";
    pub const EXTERNAL: &str = "eac";
    pub const PASSKEY: &str = "pkey";
    pub const ORG: &str = "org";
    pub const MEMBERSHIP: &str = "orgmem";
    pub const INVITATION: &str = "orginv";
    pub const DOMAIN: &str = "orgdmn";
    pub const REQUEST: &str = "orgmreq";
    pub const ROLE: &str = "role";
    pub const PERMISSION: &str = "perm";
    pub const APP_INVITATION: &str = "inv";
    pub const WAITLIST: &str = "wle";
    pub const ALLOW: &str = "alid";
    pub const BLOCK: &str = "blid";
    pub const JWT_TEMPLATE: &str = "jtmpl";
    pub const ACTOR_TOKEN: &str = "act";
    pub const SIGN_IN_TOKEN: &str = "sit";
    pub const WEBHOOK: &str = "we";
    pub const WEBHOOK_EVENT: &str = "evt";
    pub const DELIVERY: &str = "whd";
    pub const API_KEY: &str = "ak";
    pub const MACHINE: &str = "mch";
    pub const M2M_TOKEN: &str = "mt";
    pub const OAUTH_APP: &str = "oa";
    pub const OAUTH_GRANT: &str = "oag";
    pub const ENTERPRISE: &str = "ent";
    pub const AUDIT: &str = "aud";
    pub const VERIFICATION: &str = "ver";
    pub const TRUSTED_DEVICE: &str = "tdev";
    pub const OPERATOR_SESSION: &str = "osess";
}

const ALPHABET: [char; 62] = [
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I',
    'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'a', 'b',
    'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u',
    'v', 'w', 'x', 'y', 'z',
];

/// `<prefix>_<27 nanoid characters>`.
pub fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", nanoid::nanoid!(27, &ALPHABET))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefixes_and_length() {
        let id = new_id(id_prefix::USER);
        assert!(id.starts_with("user_"));
        assert_eq!(id.len(), "user_".len() + 27);
        let suffix = &id["user_".len()..];
        assert!(suffix.chars().all(|c| ALPHABET.contains(&c)));
    }

    #[test]
    fn ids_are_unique() {
        let a = new_id(id_prefix::SESSION);
        let b = new_id(id_prefix::SESSION);
        assert_ne!(a, b);
    }
}
