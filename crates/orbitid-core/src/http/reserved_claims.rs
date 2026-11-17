//! Reserved session claims, re-exported from `claims` (the single source).

pub use crate::claims::RESERVED_SESSION_CLAIMS;

/// True when a template or `customClaims` may not set `claim`.
pub fn is_reserved_claim(claim: &str) -> bool {
    RESERVED_SESSION_CLAIMS.contains(&claim)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserved() {
        assert!(is_reserved_claim("sub"));
        assert!(is_reserved_claim("org_role"));
        assert!(!is_reserved_claim("email"));
    }
}
