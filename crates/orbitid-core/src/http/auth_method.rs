//! Strategy → dashboard sign-in method, ported from `lib/auth-method.ts`.

use crate::resources::AuthMethod;

pub fn auth_method_of(strategy: Option<&str>) -> Option<AuthMethod> {
    let strategy = strategy?;
    if strategy.is_empty() {
        return None;
    }
    if strategy.starts_with("oauth_") {
        return Some(AuthMethod::Oauth);
    }
    if strategy.starts_with("reset_password") {
        return Some(AuthMethod::Password);
    }
    match strategy {
        "password" => Some(AuthMethod::Password),
        "email_code" => Some(AuthMethod::EmailCode),
        "email_link" => Some(AuthMethod::EmailLink),
        "passkey" => Some(AuthMethod::Passkey),
        "ticket" => Some(AuthMethod::Ticket),
        "phone_code" => Some(AuthMethod::Sms),
        "enterprise_sso" | "saml" => Some(AuthMethod::Sso),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_strategies() {
        assert_eq!(
            auth_method_of(Some("oauth_google")),
            Some(AuthMethod::Oauth)
        );
        assert_eq!(
            auth_method_of(Some("reset_password_email_code")),
            Some(AuthMethod::Password)
        );
        assert_eq!(auth_method_of(Some("phone_code")), Some(AuthMethod::Sms));
        assert_eq!(auth_method_of(Some("saml")), Some(AuthMethod::Sso));
        assert_eq!(auth_method_of(Some("unknown")), None);
        assert_eq!(auth_method_of(None), None);
    }
}
