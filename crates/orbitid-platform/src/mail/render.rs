//! Email template rendering, ported from the retired TypeScript server.
//!
//! Variables are untrusted (names, organization names, user agents). They never
//! carry line breaks and the templates only place them through `escape_html`, so
//! neither the subject nor the body can be injected into.

use orbitid_core::http::email_format::header_safe;
use orbitid_core::http::html::escape_html;
use serde_json::Value;

use crate::js::{string_of, strip_line_breaks_and_controls, truthy};

use super::core::{EmailTemplate, EmailVars};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedEmail {
    pub subject: String,
    pub text: String,
    pub html: String,
}

fn display(value: Option<&Value>, fallback: &str) -> String {
    match value {
        None | Some(Value::Null) => fallback.to_string(),
        Some(value) => {
            let text = string_of(value);
            if text.is_empty() {
                fallback.to_string()
            } else {
                text
            }
        }
    }
}

/// Only absolute http(s) URLs may become clickable in an email.
fn safe_http_url(value: &str) -> Option<String> {
    let url = url::Url::parse(value).ok()?;
    if url.scheme() == "http" || url.scheme() == "https" {
        Some(url.to_string())
    } else {
        None
    }
}

fn sanitized(vars: &EmailVars) -> EmailVars {
    let mut clean = EmailVars::new();
    for (key, value) in vars {
        let value = match value {
            Value::String(text) => Value::String(strip_line_breaks_and_controls(text)),
            other => other.clone(),
        };
        clean.insert(key.clone(), value);
    }
    clean
}

fn first_non_null<'a>(vars: &'a EmailVars, keys: &[&str]) -> Option<&'a Value> {
    keys.iter()
        .find_map(|key| vars.get(*key).filter(|value| !matches!(value, Value::Null)))
}

/// Renders one template exactly like the TypeScript server.
pub fn render_email(
    template: EmailTemplate,
    raw_vars: &EmailVars,
    app_name: &str,
    primary_color: &str,
) -> RenderedEmail {
    let vars = sanitized(raw_vars);
    let code = display(vars.get("code"), "");
    let link = safe_http_url(&display(
        first_non_null(&vars, &["link", "invitation_url", "url"]),
        "",
    ))
    .unwrap_or_default();
    let minutes = display(vars.get("expires_in_minutes"), "10");
    let greeting = if vars.get("user_name").is_some_and(truthy) {
        format!("Hi {},", display(vars.get("user_name"), ""))
    } else {
        "Hello,".to_string()
    };
    let brand = {
        let header = header_safe(app_name);
        if header.is_empty() {
            "OrbitID".to_string()
        } else {
            header
        }
    };

    let mut action: &str = "";
    let (subject, intro, body) = match template {
        EmailTemplate::VerificationCode => (
            format!("{code} is your {brand} verification code"),
            format!("{greeting} use this code to verify your email address."),
            format!(
                "The code expires in {minutes} minutes. If you did not request it, you can ignore this email."
            ),
        ),
        EmailTemplate::MagicLink => {
            action = "Sign in";
            (
                format!("Sign in to {brand}"),
                format!("{greeting} use the button below to sign in to {brand}."),
                format!(
                    "This link expires in {minutes} minutes and can only be used once. If you did not request it, you can ignore this email."
                ),
            )
        }
        EmailTemplate::ResetPasswordCode => (
            format!("{code} is your {brand} password reset code"),
            format!("{greeting} use this code to reset your password."),
            format!(
                "The code expires in {minutes} minutes. If you did not request a reset, you can ignore this email."
            ),
        ),
        EmailTemplate::Invitation => {
            action = "Accept invitation";
            (
                format!("You have been invited to {brand}"),
                format!("{greeting} you have been invited to join {brand}."),
                "Accept the invitation to create your account.".to_string(),
            )
        }
        EmailTemplate::OrganizationInvitation => {
            action = "Accept invitation";
            (
                format!(
                    "Join {} on {brand}",
                    display(vars.get("organization_name"), &brand)
                ),
                format!(
                    "{greeting} {} invited you to join {}.",
                    display(vars.get("inviter_name"), "An administrator"),
                    display(vars.get("organization_name"), "an organization")
                ),
                "Accept the invitation to join the organization.".to_string(),
            )
        }
        EmailTemplate::PasswordChanged => (
            format!("Your {brand} password was changed"),
            format!("{greeting} the password for your {brand} account was changed."),
            "If you did not make this change, reset your password immediately and contact support."
                .to_string(),
        ),
        EmailTemplate::NewSignIn => (
            format!("New sign-in to your {brand} account"),
            format!("{greeting} a new sign-in to your {brand} account was detected."),
            format!(
                "When: {}\nIP address: {}\nDevice: {}\n\nIf this was not you, change your password immediately.",
                display(vars.get("date"), "just now"),
                display(vars.get("ip_address"), "unknown"),
                display(vars.get("user_agent"), "unknown")
            ),
        ),
        EmailTemplate::WaitlistInvited => {
            action = "Create account";
            (
                format!("You are off the waitlist for {brand}"),
                format!("{greeting} you have been invited to join {brand}."),
                "Use the button below to create your account.".to_string(),
            )
        }
        EmailTemplate::DomainVerificationCode => (
            format!("{code} is your {brand} domain verification code"),
            format!(
                "{greeting} use this code to verify ownership of {}.",
                display(vars.get("domain"), "your domain")
            ),
            format!("The code expires in {minutes} minutes."),
        ),
        EmailTemplate::TestEmail => (
            format!("{brand} test email"),
            format!("This is a test email from {brand}."),
            "If you received it, email delivery from this instance works.".to_string(),
        ),
    };

    let safe_subject = header_safe(&subject);
    let action_block = if !action.is_empty() && !link.is_empty() {
        format!(
            "<p style=\"margin:24px 0\"><a href=\"{}\" style=\"background:{};color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600\">{}</a></p>",
            escape_html(&link),
            escape_html(primary_color),
            escape_html(action)
        )
    } else {
        String::new()
    };
    let code_block = if code.is_empty() {
        String::new()
    } else {
        format!(
            "<p style=\"font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:32px;letter-spacing:8px;font-weight:700;margin:24px 0\">{}</p>",
            escape_html(&code)
        )
    };
    let html = format!(
        "<!doctype html><html><body style=\"margin:0;background:#f6f7f9;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827\">\n<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\"><tr><td align=\"center\">\n<table role=\"presentation\" width=\"100%\" style=\"max-width:520px;background:#fff;border-radius:12px;padding:32px\">\n<tr><td style=\"font-size:18px;font-weight:700;color:{}\">{}</td></tr>\n<tr><td style=\"padding-top:16px;font-size:15px;line-height:1.6\"><p>{}</p>{}{}<p style=\"color:#4b5563;white-space:pre-line\">{}</p></td></tr>\n<tr><td style=\"padding-top:24px;font-size:12px;color:#9ca3af\">Sent by {}</td></tr>\n</table></td></tr></table></body></html>",
        escape_html(primary_color),
        escape_html(&brand),
        escape_html(&intro),
        code_block,
        action_block,
        escape_html(&body),
        escape_html(&brand)
    );

    let mut text_parts: Vec<String> = Vec::new();
    if !intro.is_empty() {
        text_parts.push(intro);
    }
    if !code.is_empty() {
        text_parts.push(format!("Code: {code}"));
    }
    if !action.is_empty() && !link.is_empty() {
        text_parts.push(format!("{action}: {link}"));
    }
    if !body.is_empty() {
        text_parts.push(body);
    }
    text_parts.push(format!("— {brand}"));

    RenderedEmail {
        subject: safe_subject,
        text: text_parts.join("\n"),
        html,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn vars(value: serde_json::Value) -> EmailVars {
        value.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn verification_code_subject_and_body_match_typescript() {
        let rendered = render_email(
            EmailTemplate::VerificationCode,
            &vars(json!({ "code": "424242" })),
            "OrbitID App",
            "#2b2522",
        );
        assert_eq!(
            rendered.subject,
            "424242 is your OrbitID App verification code"
        );
        assert!(rendered
            .text
            .starts_with("Hello, use this code to verify your email address."));
        assert!(rendered.text.contains("Code: 424242"));
        assert!(rendered.text.ends_with("— OrbitID App"));
        assert!(rendered.html.contains("424242"));
    }

    #[test]
    fn organization_invitation_escapes_variables_and_drops_javascript_links() {
        let rendered = render_email(
            EmailTemplate::OrganizationInvitation,
            &vars(json!({
                "invitation_url": "javascript:alert(1)",
                "organization_name": "<img src=x onerror=alert(1)>",
                "inviter_name": "A&B"
            })),
            "OrbitID App",
            "#2b2522",
        );
        assert_eq!(
            rendered.subject,
            "Join <img src=x onerror=alert(1)> on OrbitID App"
        );
        assert!(!rendered.html.contains("javascript:alert(1)"));
        assert!(!rendered.html.contains("<img src=x"));
        assert!(rendered.html.contains("&lt;img src=x onerror=alert(1)&gt;"));
        assert!(rendered.html.contains("A&amp;B"));
    }

    #[test]
    fn magic_link_keeps_absolute_https_urls() {
        let rendered = render_email(
            EmailTemplate::MagicLink,
            &vars(json!({ "link": "https://auth.example.com/v1/verify?token=abc" })),
            "OrbitID App",
            "#2b2522",
        );
        assert!(rendered
            .html
            .contains("href=\"https://auth.example.com/v1/verify?token=abc\""));
        assert!(rendered
            .text
            .contains("Sign in: https://auth.example.com/v1/verify?token=abc"));
    }

    #[test]
    fn line_breaks_never_enter_headers() {
        let rendered = render_email(
            EmailTemplate::NewSignIn,
            &vars(json!({
                "user_name": "Ada\r\nBcc: attacker@example.com",
                "ip_address": "203.0.113.7\r\nX-Injected: yes"
            })),
            "Acme\r\nBcc: leak@example.com",
            "#2b2522",
        );
        assert!(!rendered.subject.contains('\r'));
        assert!(!rendered.subject.contains('\n'));
        assert!(rendered.text.contains("Ada Bcc: attacker@example.com"));
    }
}
