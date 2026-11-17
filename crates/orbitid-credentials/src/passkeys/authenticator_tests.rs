use super::*;
use crate::passkeys::webauthn::{
    creation_options, request_options, verify_authentication, verify_registration,
};

#[test]
fn rounds_trip_es256_and_rs256() {
    for algorithm in [VirtualAlgorithm::Es256, VirtualAlgorithm::Rs256] {
        let mut options = VirtualAuthenticatorOptions::new("localhost", "http://localhost:3000");
        options.alg = algorithm;
        options.transports = vec!["internal".into()];
        let mut authenticator = VirtualAuthenticator::new(options).unwrap();
        let creation = creation_options(
            "OrbitID App",
            "localhost",
            "user_1",
            "ada",
            "Ada",
            None,
            Vec::new(),
        );
        let credential = authenticator.register(&creation, CredentialOverrides::default());
        let registration = verify_registration(
            &credential,
            &creation.challenge,
            "http://localhost:3000",
            "localhost",
            true,
        )
        .unwrap();
        assert_eq!(registration.device_type, "multiDevice");
        assert!(registration.backed_up);

        let request = request_options("localhost", Vec::new());
        let assertion = authenticator.authenticate(&request, CredentialOverrides::default());
        let info = verify_authentication(
            &assertion,
            &request.challenge,
            "http://localhost:3000",
            "localhost",
            &registration.public_key,
            0,
            true,
        )
        .unwrap();
        assert_eq!(info.new_counter, 1);
    }
}

#[test]
fn negative_overrides_are_rejected() {
    let mut authenticator = VirtualAuthenticator::new(VirtualAuthenticatorOptions::new(
        "localhost",
        "http://localhost:3000",
    ))
    .unwrap();
    let creation = creation_options(
        "OrbitID App",
        "localhost",
        "user_1",
        "ada",
        "Ada",
        None,
        Vec::new(),
    );
    let credential = authenticator.register(
        &creation,
        CredentialOverrides {
            challenge: Some("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into()),
            ..Default::default()
        },
    );
    assert!(verify_registration(
        &credential,
        &creation.challenge,
        "http://localhost:3000",
        "localhost",
        true
    )
    .is_err());
}
