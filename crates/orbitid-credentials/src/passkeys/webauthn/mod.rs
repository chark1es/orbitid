//! WebAuthn wire types and verification rules matching
//! `@simplewebauthn/server` v13 as used by `services/passkeys.ts`.
//!
//! Registration requests `attestation: "none"`; the verifier accepts `fmt:
//! "none"` and refuses the direct-attestation formats whose certificate chains
//! this server has no trust store for. Authentication accepts the credential
//! algorithms a passkey can realistically use (ES256, RS256/384/512,
//! PS256/384/512, EdDSA).

mod cose;
mod types;
mod verify;

pub use types::{
    creation_options, new_challenge, request_options, AuthenticationInfo,
    AuthenticationResponseData, AuthenticationResponseJson, AuthenticatorSelection,
    CreationOptionsJson, CredentialDescriptor, PubKeyCredParam, RegistrationInfo,
    RegistrationResponseData, RegistrationResponseJson, RequestOptionsJson, RpEntity, UserEntity,
    WebauthnError,
};
pub use verify::{verify_authentication, verify_registration};

#[cfg(any(feature = "test-util", test))]
pub(crate) use cose::encode_cose_map;
pub(crate) use types::{b64_decode, b64_encode};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn challenges_are_unique_and_long() {
        let first = new_challenge();
        let second = new_challenge();
        assert_ne!(first, second);
        assert_eq!(b64_decode(&first).unwrap().len(), 32);
    }

    #[test]
    fn options_match_simplewebauthn_shape() {
        let options = creation_options(
            "OrbitID App",
            "localhost",
            "user_1",
            "ada",
            "Ada",
            None,
            Vec::new(),
        );
        let value = serde_json::to_value(options).unwrap();
        assert_eq!(value["rp"]["id"], "localhost");
        assert_eq!(value["attestation"], "none");
        assert_eq!(value["pubKeyCredParams"][1]["alg"], -7);
        assert_eq!(value["authenticatorSelection"]["residentKey"], "preferred");
        assert_eq!(value["authenticatorSelection"]["requireResidentKey"], false);
        assert_eq!(value["extensions"]["credProps"], true);
        assert_eq!(value["hints"], serde_json::json!([]));
        let request = serde_json::to_value(request_options("localhost", Vec::new())).unwrap();
        assert_eq!(request["rpId"], "localhost");
        assert!(request.get("extensions").is_none());
    }

    #[test]
    fn rejects_truncated_authenticator_data() {
        assert!(super::verify::parse_auth_data(&[0u8; 10]).is_err());
    }
}
