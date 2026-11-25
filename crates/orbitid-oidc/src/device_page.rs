//! Server-rendered page for the OAuth 2.0 device grant verification URI
//! (`GET /oauth/device`), ported from `modules/oidc-device-page.ts`.
//!
//! No framework and no inline script or style: everything the page needs is
//! served from this origin under a strict Content-Security-Policy, and every
//! interpolated value is escaped.

use crate::web::escape_html;

pub const DEVICE_PAGE_CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; \
connect-src 'none'; img-src 'self' data:; form-action 'self'; base-uri 'none'; \
frame-ancestors 'none'";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DevicePageState {
    EnterCode,
    NotFound,
    Expired,
    AlreadyDecided,
    SignInRequired,
    /// Signed in, but the account may not use this organization-owned
    /// application: no application details are shown.
    NotAllowed,
    Consent,
}

#[derive(Debug, Clone)]
pub struct DevicePageInput {
    pub signed_in: bool,
    pub sign_in_href: String,
    pub code: Option<String>,
    pub app_name: Option<String>,
    pub scopes: Vec<String>,
    pub scopes_with_descriptions: Option<Vec<(String, String)>>,
    pub state: DevicePageState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceResultState {
    Approved,
    Denied,
    /// The signed-in user may not use this organization-owned application.
    NotAllowed,
    TooManyAttempts,
    CrossSite,
}

fn shell(title: &str, product: &str, body: &str) -> String {
    format!(
        "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n\
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
<title>{}</title>\n<link rel=\"stylesheet\" href=\"/oauth/device.css\">\n</head>\n<body>\n\
<main class=\"card\">\n<p class=\"brand\">{}</p>\n{}\n</main>\n\
<script src=\"/oauth/device.js\" defer></script>\n</body>\n</html>",
        escape_html(title),
        escape_html(product),
        body
    )
}

fn scope_list(scopes: &[(String, String)]) -> String {
    let items: String = scopes
        .iter()
        .map(|(scope, description)| {
            format!(
                "<li><strong>{}</strong> <span>{}</span></li>",
                escape_html(scope),
                escape_html(description)
            )
        })
        .collect();
    format!("<ul class=\"scopes\">{items}</ul>")
}

fn code_form(code: Option<&str>) -> String {
    format!(
        "<form method=\"post\" action=\"/oauth/device\" class=\"code-form\">\n\
<label for=\"user_code\">Enter the code shown on your device</label>\n\
<input id=\"user_code\" name=\"user_code\" class=\"code-input\" inputmode=\"text\" autocomplete=\"off\" autocapitalize=\"characters\"\n  \
spellcheck=\"false\" maxlength=\"9\" placeholder=\"ABCD-EFGH\" value=\"{}\" required>\n\
<button type=\"submit\" name=\"action\" value=\"continue\" class=\"secondary\">Continue</button>\n</form>",
        escape_html(code.unwrap_or(""))
    )
}

/// Renders the verification page for the given state. `product` is the instance
/// name, never user input.
pub fn device_page_html(input: &DevicePageInput, product: &str) -> String {
    let title = format!("Connect a device — {product}");
    let intro = "<h1>Connect a device</h1>";
    let sign_in_link = if input.signed_in {
        String::new()
    } else {
        format!(
            "<p class=\"muted\">You are not signed in.</p>\
<p><a class=\"button\" href=\"{}\">Sign in</a></p>",
            escape_html(&input.sign_in_href)
        )
    };
    let app_name = escape_html(input.app_name.as_deref().unwrap_or("An application"));
    let body = match input.state {
        DevicePageState::EnterCode => format!(
            "{intro}<p class=\"muted\">Enter the code shown on the device you want to connect.</p>\
{sign_in_link}{}",
            code_form(None)
        ),
        DevicePageState::NotFound => format!(
            "{intro}<p class=\"error\">That code is not valid. Check the device screen and try again.</p>\
{sign_in_link}{}",
            code_form(input.code.as_deref())
        ),
        DevicePageState::Expired => format!(
            "{intro}<p class=\"error\">That code has expired. Start again from your device to get a new one.</p>\
{sign_in_link}{}",
            code_form(None)
        ),
        DevicePageState::AlreadyDecided => format!(
            "{intro}<p class=\"error\">That code has already been used. Start again from your device to get a new one.</p>\
{sign_in_link}"
        ),
        DevicePageState::SignInRequired => format!(
            "{intro}\n<p><strong>{app_name}</strong> wants to connect to your account.</p>\n\
{sign_in_link}\n{}",
            code_form(input.code.as_deref())
        ),
        DevicePageState::NotAllowed => format!(
            "{intro}<p class=\"error\">Your account does not have access to the application behind this code. \
Ask an administrator for access. To use a different account, sign out, sign in with it and open this page again.</p>\
{sign_in_link}"
        ),
        DevicePageState::Consent => {
            let described: Vec<(String, String)> = match &input.scopes_with_descriptions {
                Some(described) => described.clone(),
                None => input
                    .scopes
                    .iter()
                    .map(|scope| (scope.clone(), format!("Access to {scope}")))
                    .collect(),
            };
            format!(
                "{intro}\n<p><strong>{app_name}</strong> wants to connect to your account.</p>\n\
<p class=\"muted\">It is asking for:</p>\n{}\n\
<form method=\"post\" action=\"/oauth/device\" class=\"decision-form\">\n\
<input type=\"hidden\" name=\"user_code\" value=\"{}\">\n\
<button type=\"submit\" name=\"action\" value=\"approve\">Allow</button>\n\
<button type=\"submit\" name=\"action\" value=\"deny\" class=\"secondary\">Deny</button>\n</form>\n\
<p class=\"muted small\">Only continue if you started this request yourself.</p>",
                scope_list(&described),
                escape_html(input.code.as_deref().unwrap_or(""))
            )
        }
    };
    shell(&title, product, &body)
}

/// Terminal page shown after a decision (or after too many wrong codes).
pub fn device_result_html(
    state: DeviceResultState,
    app_name: Option<&str>,
    product: &str,
) -> String {
    let title = format!("Connect a device — {product}");
    let body = match state {
        DeviceResultState::Approved => format!(
            "<h1>Device connected</h1><p><strong>{}</strong> can now use your account. \
You can close this window.</p>",
            escape_html(app_name.unwrap_or("The application"))
        ),
        DeviceResultState::Denied => "<h1>Request denied</h1><p>The device was not given access. \
You can close this window.</p>"
            .to_string(),
        DeviceResultState::NotAllowed => {
            "<h1>Access not allowed</h1><p>Your account does not have \
access to this application, so the device was not connected. Ask an administrator for access. \
You can close this window.</p>"
                .to_string()
        }
        DeviceResultState::TooManyAttempts => {
            "<h1>Too many attempts</h1><p>That code is no longer \
valid. Start again from your device to get a new one.</p>"
                .to_string()
        }
        DeviceResultState::CrossSite => {
            "<h1>Request blocked</h1><p>Open the verification link from \
this site to continue.</p>"
                .to_string()
        }
    };
    shell(&title, product, &body)
}
