//! JWS algorithm identifiers.

/// A JWS signing algorithm. Values are the wire identifiers used in the
/// `alg` header, exactly as `jose` writes them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum JwsAlgorithm {
    HS256,
    HS384,
    HS512,
    RS256,
    RS384,
    RS512,
    PS256,
    PS384,
    PS512,
    ES256,
    EdDsa,
}

impl JwsAlgorithm {
    /// The wire identifier (`"RS256"`, …).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::HS256 => "HS256",
            Self::HS384 => "HS384",
            Self::HS512 => "HS512",
            Self::RS256 => "RS256",
            Self::RS384 => "RS384",
            Self::RS512 => "RS512",
            Self::PS256 => "PS256",
            Self::PS384 => "PS384",
            Self::PS512 => "PS512",
            Self::ES256 => "ES256",
            Self::EdDsa => "EdDSA",
        }
    }

    /// Parses a wire identifier. Case-sensitive, like `jose`.
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "HS256" => Self::HS256,
            "HS384" => Self::HS384,
            "HS512" => Self::HS512,
            "RS256" => Self::RS256,
            "RS384" => Self::RS384,
            "RS512" => Self::RS512,
            "PS256" => Self::PS256,
            "PS384" => Self::PS384,
            "PS512" => Self::PS512,
            "ES256" => Self::ES256,
            "EdDSA" => Self::EdDsa,
            _ => return None,
        })
    }

    pub fn is_hmac(self) -> bool {
        matches!(self, Self::HS256 | Self::HS384 | Self::HS512)
    }

    pub fn is_rsa(self) -> bool {
        matches!(
            self,
            Self::RS256 | Self::RS384 | Self::RS512 | Self::PS256 | Self::PS384 | Self::PS512
        )
    }

    pub fn is_pss(self) -> bool {
        matches!(self, Self::PS256 | Self::PS384 | Self::PS512)
    }

    pub fn is_ec(self) -> bool {
        matches!(self, Self::ES256)
    }
}

impl std::fmt::Display for JwsAlgorithm {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_wire_identifiers() {
        for algorithm in [
            JwsAlgorithm::HS256,
            JwsAlgorithm::RS256,
            JwsAlgorithm::PS256,
            JwsAlgorithm::ES256,
            JwsAlgorithm::EdDsa,
        ] {
            assert_eq!(JwsAlgorithm::parse(algorithm.as_str()), Some(algorithm));
        }
        assert_eq!(JwsAlgorithm::parse("none"), None);
        assert_eq!(JwsAlgorithm::parse("rs256"), None);
    }
}
