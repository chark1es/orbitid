//! HMAC-based JWS algorithms (HS256/384/512).

use hmac::{Hmac, Mac};
use sha2::{Sha256, Sha384, Sha512};

use super::{JwkError, JwsAlgorithm};

pub(crate) fn sign(
    algorithm: JwsAlgorithm,
    secret: &[u8],
    data: &[u8],
) -> Result<Vec<u8>, JwkError> {
    match algorithm {
        JwsAlgorithm::HS256 => {
            let mut mac =
                Hmac::<Sha256>::new_from_slice(secret).map_err(|_| JwkError::KeyMismatch)?;
            mac.update(data);
            Ok(mac.finalize().into_bytes().to_vec())
        }
        JwsAlgorithm::HS384 => {
            let mut mac =
                Hmac::<Sha384>::new_from_slice(secret).map_err(|_| JwkError::KeyMismatch)?;
            mac.update(data);
            Ok(mac.finalize().into_bytes().to_vec())
        }
        JwsAlgorithm::HS512 => {
            let mut mac =
                Hmac::<Sha512>::new_from_slice(secret).map_err(|_| JwkError::KeyMismatch)?;
            mac.update(data);
            Ok(mac.finalize().into_bytes().to_vec())
        }
        _ => Err(JwkError::UnsupportedAlgorithm(algorithm.as_str().into())),
    }
}
