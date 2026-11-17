//! Verification magic-link URL construction.

use orbitid_core::state::AppState;

/// `<baseUrl>/v1/verify?token=…`.
pub fn magic_link_url(state: &AppState, token: &str, params: &[(&str, Option<&str>)]) -> String {
    let mut url = match url::Url::parse(&format!(
        "{}/v1/verify",
        state.env.base_url.trim_end_matches('/')
    )) {
        Ok(url) => url,
        Err(_) => return format!("{}/v1/verify?token={token}", state.env.base_url),
    };
    url.query_pairs_mut().append_pair("token", token);
    for (key, value) in params {
        if let Some(value) = value {
            url.query_pairs_mut().append_pair(key, value);
        }
    }
    url.to_string()
}
