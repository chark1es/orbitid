//! A local JWK set, equivalent to `jose.createLocalJWKSet`.

use serde_json::{Map, Value};

use super::{Jwk, JwkError, JwsAlgorithm};

/// A local JWK set, equivalent to `jose.createLocalJWKSet`.
#[derive(Clone, Debug, Default)]
pub struct JwkSet {
    keys: Vec<Jwk>,
}

impl JwkSet {
    pub fn new(keys: Vec<Jwk>) -> Self {
        Self { keys }
    }

    /// Parses `{ "keys": [...] }`. Invalid entries are skipped, like a JWKS
    /// document that carries a key type this server does not implement.
    pub fn from_value(value: &Value) -> Result<Self, JwkError> {
        let keys = value
            .get("keys")
            .and_then(Value::as_array)
            .ok_or_else(|| JwkError::InvalidJwk("expected a keys array".into()))?;
        Ok(Self {
            keys: keys
                .iter()
                .filter_map(|key| Jwk::from_value(key).ok())
                .collect(),
        })
    }

    pub fn keys(&self) -> &[Jwk] {
        &self.keys
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert(
            "keys".into(),
            Value::Array(self.keys.iter().map(|key| key.to_value(false)).collect()),
        );
        Value::Object(map)
    }

    pub(crate) fn candidates(&self, kid: Option<&str>, algorithm: JwsAlgorithm) -> Vec<&Jwk> {
        self.keys
            .iter()
            .filter(|key| key.supports(algorithm) && key.key_use_is_sig())
            .filter(|key| key.alg().is_none_or(|alg| alg == algorithm))
            .filter(|key| kid.is_none_or(|kid| key.kid() == Some(kid)))
            .collect()
    }
}

impl From<JwkError> for std::io::Error {
    fn from(error: JwkError) -> Self {
        std::io::Error::new(std::io::ErrorKind::InvalidData, error)
    }
}
