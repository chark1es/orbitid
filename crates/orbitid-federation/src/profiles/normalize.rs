//! Provider-specific userinfo/profile normalization.

use serde_json::Value;

use super::{at, bool_or_undefined, id_string, rec, str_opt, str_or_empty};
use crate::oauth::OAuthTokenSet;
use crate::profile::{build_profile, ExternalProfile};

fn split_name(name: Option<String>) -> (Option<String>, Option<String>) {
    let Some(name) = name else {
        return (None, None);
    };
    let mut parts = name.split(' ');
    let first = parts.next().unwrap_or("").to_string();
    let rest = parts.collect::<Vec<_>>().join(" ");
    (
        (!first.is_empty()).then_some(first),
        (!rest.is_empty()).then_some(rest),
    )
}

fn local_part(email: &Option<String>) -> Option<String> {
    email
        .as_deref()
        .and_then(|value| value.split('@').next())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// The normalized profile of a built-in provider's userinfo payload.
pub fn normalize_profile(key: &str, data: &Value, tokens: &OAuthTokenSet) -> ExternalProfile {
    let d = rec(data);
    let field = |name: &str| d.get(name).cloned().unwrap_or(Value::Null);
    let mut profile = match key {
        "google" => {
            let email = str_opt(&field("email"));
            let subject = {
                let sub = str_or_empty(&field("sub"));
                if sub.is_empty() {
                    str_or_empty(&field("email"))
                } else {
                    sub
                }
            };
            let mut p = build_profile(key, subject, Some(tokens));
            p.email = email.clone();
            p.email_verified = Some(bool_or_undefined(&field("email_verified")).unwrap_or(false));
            p.first_name = str_opt(&field("given_name"));
            p.last_name = str_opt(&field("family_name"));
            p.username = local_part(&email);
            p.image_url = str_opt(&field("picture"));
            p
        }
        "github" => {
            let name = str_opt(&field("name"));
            let (first, last) = split_name(name);
            let mut p = build_profile(key, id_string(&field("id")), Some(tokens));
            p.email = str_opt(&field("email"));
            p.email_verified = Some(false);
            p.first_name = first;
            p.last_name = last;
            p.username = str_opt(&field("login"));
            p.image_url = str_opt(&field("avatar_url"));
            p
        }
        "gitlab" => {
            let name = str_opt(&field("name"));
            let (first, last) = split_name(name);
            let mut p = build_profile(key, id_string(&field("id")), Some(tokens));
            p.email = str_opt(&field("email"));
            p.email_verified = Some(field("confirmed_at").is_string());
            p.first_name = first;
            p.last_name = last;
            p.username = str_opt(&field("username"));
            p.image_url = str_opt(&field("avatar_url"));
            p
        }
        "discord" => {
            let avatar = str_opt(&field("avatar"));
            let mut p = build_profile(key, id_string(&field("id")), Some(tokens));
            p.email = str_opt(&field("email"));
            p.email_verified = Some(bool_or_undefined(&field("verified")).unwrap_or(false));
            p.username = str_opt(&field("username"));
            p.image_url = avatar.map(|avatar| {
                format!(
                    "https://cdn.discordapp.com/avatars/{}/{}.png",
                    id_string(&field("id")),
                    avatar
                )
            });
            p
        }
        "microsoft" => {
            let email = str_opt(&field("email")).or_else(|| str_opt(&field("preferred_username")));
            let subject = {
                let sub = str_or_empty(&field("sub"));
                if !sub.is_empty() {
                    sub
                } else {
                    let oid = str_or_empty(&field("oid"));
                    if !oid.is_empty() {
                        oid
                    } else {
                        email.clone().unwrap_or_default()
                    }
                }
            };
            let mut p = build_profile(key, subject, Some(tokens));
            p.email = email.clone();
            p.email_verified = Some(false);
            p.first_name = str_opt(&field("given_name"));
            p.last_name = str_opt(&field("family_name"));
            p.username = local_part(&email);
            p.image_url = str_opt(&field("picture"));
            p
        }
        "facebook" => {
            let (first, last) = split_name(str_opt(&field("name")));
            let mut p = build_profile(key, id_string(&field("id")), Some(tokens));
            p.email = str_opt(&field("email"));
            p.email_verified = Some(false);
            p.first_name = str_opt(&field("first_name")).or(first);
            p.last_name = str_opt(&field("last_name")).or(last);
            p.image_url = str_opt(&at(data, "picture.data.url"));
            p
        }
        "twitter" | "x" => {
            let nested_value = field("data");
            let nested = rec(&nested_value);
            let get = |name: &str| nested.get(name).cloned().unwrap_or(Value::Null);
            let mut p = build_profile(key, id_string(&get("id")), Some(tokens));
            p.username = str_opt(&get("username"));
            p.first_name = str_opt(&get("name"));
            p.image_url = str_opt(&get("profile_image_url"));
            p
        }
        "linkedin_oidc" => {
            let email = str_opt(&field("email"));
            let subject = {
                let sub = str_or_empty(&field("sub"));
                if sub.is_empty() {
                    str_or_empty(&field("email"))
                } else {
                    sub
                }
            };
            let mut p = build_profile(key, subject, Some(tokens));
            p.email = email;
            p.email_verified = Some(bool_or_undefined(&field("email_verified")).unwrap_or(false));
            p.first_name = str_opt(&field("given_name"));
            p.last_name = str_opt(&field("family_name"));
            p.image_url = str_opt(&field("picture"));
            p
        }
        "slack" => {
            let email = str_opt(&field("email"));
            let subject = {
                let sub = str_or_empty(&field("sub"));
                if sub.is_empty() {
                    str_or_empty(&field("email"))
                } else {
                    sub
                }
            };
            let mut p = build_profile(key, subject, Some(tokens));
            p.email = email;
            p.email_verified = Some(bool_or_undefined(&field("email_verified")).unwrap_or(false));
            p.first_name = str_opt(&field("name"));
            p.image_url = str_opt(&field("picture"));
            p
        }
        "twitch" => {
            let nested = match field("data") {
                Value::Array(values) => values.first().cloned().unwrap_or(Value::Null),
                _ => Value::Null,
            };
            let get = |name: &str| rec(&nested).get(name).cloned().unwrap_or(Value::Null);
            let mut p = build_profile(key, id_string(&get("id")), Some(tokens));
            p.email = str_opt(&get("email"));
            p.email_verified = Some(false);
            p.username = str_opt(&get("display_name"));
            p.first_name = str_opt(&get("display_name"));
            p.image_url = str_opt(&get("profile_image_url"));
            p
        }
        "spotify" => {
            let display = str_opt(&field("display_name"));
            let image = match field("images") {
                Value::Array(values) => values.first().cloned().unwrap_or(Value::Null),
                _ => Value::Null,
            };
            let mut p = build_profile(key, id_string(&field("id")), Some(tokens));
            p.email = str_opt(&field("email"));
            p.email_verified = Some(false);
            p.first_name = display.clone();
            p.username = display;
            p.image_url = str_opt(&at(&image, "url"));
            p
        }
        "bitbucket" => {
            let subject = {
                let uuid = str_or_empty(&field("uuid"));
                if uuid.is_empty() {
                    str_or_empty(&field("username"))
                } else {
                    uuid
                }
            };
            let mut p = build_profile(key, subject, Some(tokens));
            p.email = str_opt(&field("email"));
            p.email_verified = Some(false);
            p.first_name = str_opt(&field("display_name"));
            p.username = str_opt(&field("username"));
            p.image_url = str_opt(&at(data, "links.avatar.href"));
            p
        }
        "dropbox" => {
            let mut p = build_profile(key, str_or_empty(&field("account_id")), Some(tokens));
            p.email = str_opt(&field("email"));
            p.email_verified = Some(bool_or_undefined(&field("email_verified")).unwrap_or(false));
            p.first_name = str_opt(&at(data, "name.display_name"));
            p.image_url = str_opt(&field("profile_photo_url"));
            p
        }
        "notion" => {
            let subject = {
                let id = str_or_empty(&field("id"));
                if id.is_empty() {
                    str_or_empty(&field("bot_id"))
                } else {
                    id
                }
            };
            let mut p = build_profile(key, subject, Some(tokens));
            p.email = str_opt(&at(data, "person.email"));
            p.email_verified = Some(false);
            p.first_name = str_opt(&field("name"));
            p.image_url = str_opt(&field("avatar_url"));
            p
        }
        "hubspot" => {
            let subject = {
                let user = str_or_empty(&field("user"));
                if user.is_empty() {
                    str_or_empty(&field("hub_id"))
                } else {
                    user
                }
            };
            let mut p = build_profile(key, subject, Some(tokens));
            p.email = str_opt(&field("user"));
            p.email_verified = Some(false);
            p
        }
        "tiktok" => {
            let nested = at(data, "data.user");
            let get = |name: &str| rec(&nested).get(name).cloned().unwrap_or(Value::Null);
            let subject = {
                let open = str_or_empty(&get("open_id"));
                if open.is_empty() {
                    str_or_empty(&get("union_id"))
                } else {
                    open
                }
            };
            let mut p = build_profile(key, subject, Some(tokens));
            p.first_name = str_opt(&get("display_name"));
            p.username = str_opt(&get("display_name"));
            p.image_url = str_opt(&get("avatar_url"));
            p
        }
        "coinbase" => {
            let nested = field("data");
            let get = |name: &str| rec(&nested).get(name).cloned().unwrap_or(Value::Null);
            let mut p = build_profile(key, str_or_empty(&get("id")), Some(tokens));
            p.email = str_opt(&get("email"));
            p.email_verified = Some(false);
            p.first_name = str_opt(&get("name"));
            p.username = str_opt(&get("username"));
            p.image_url = str_opt(&get("avatar_url"));
            p
        }
        "line" => {
            let mut p = build_profile(key, str_or_empty(&field("userId")), Some(tokens));
            p.first_name = str_opt(&field("displayName"));
            p.image_url = str_opt(&field("pictureUrl"));
            p
        }
        "linear" => {
            let nested = at(data, "data.viewer");
            let get = |name: &str| rec(&nested).get(name).cloned().unwrap_or(Value::Null);
            let mut p = build_profile(key, str_or_empty(&get("id")), Some(tokens));
            p.email = str_opt(&get("email"));
            p.email_verified = Some(false);
            p.first_name = str_opt(&get("name"));
            p.username = str_opt(&get("displayName"));
            p.image_url = str_opt(&get("avatarUrl"));
            p
        }
        "huggingface" => {
            let mut p = build_profile(key, str_or_empty(&field("id")), Some(tokens));
            p.email = str_opt(&field("email"));
            p.email_verified = Some(bool_or_undefined(&field("emailVerified")).unwrap_or(false));
            p.first_name = str_opt(&field("fullname")).or_else(|| str_opt(&field("name")));
            p.username = str_opt(&field("name"));
            p.image_url = str_opt(&field("avatarUrl"));
            p
        }
        "box" => {
            let mut p = build_profile(key, str_or_empty(&field("id")), Some(tokens));
            p.email = str_opt(&field("login"));
            p.email_verified = Some(false);
            p.first_name = str_opt(&field("name"));
            p.username = str_opt(&field("login"));
            p.image_url = str_opt(&field("avatar_url"));
            p
        }
        "atlassian" => {
            let subject = {
                let account = str_or_empty(&field("account_id"));
                if account.is_empty() {
                    str_or_empty(&field("email"))
                } else {
                    account
                }
            };
            let mut p = build_profile(key, subject, Some(tokens));
            p.email = str_opt(&field("email"));
            p.email_verified = Some(false);
            p.first_name = str_opt(&field("name"));
            p.image_url = str_opt(&field("picture"));
            p
        }
        "zoom" => {
            let email = str_opt(&field("email"));
            let subject = {
                let id = str_or_empty(&field("id"));
                if id.is_empty() {
                    email.clone().unwrap_or_default()
                } else {
                    id
                }
            };
            let mut p = build_profile(key, subject, Some(tokens));
            p.email = email.clone();
            p.email_verified = Some(false);
            p.first_name = str_opt(&field("first_name"));
            p.last_name = str_opt(&field("last_name"));
            p.username = local_part(&email);
            p.image_url = str_opt(&field("pic_url"));
            p
        }
        _ => {
            let email = str_opt(&field("email"));
            let subject = {
                let sub = str_or_empty(&field("sub"));
                if !sub.is_empty() {
                    sub
                } else {
                    let id = str_or_empty(&field("id"));
                    if !id.is_empty() {
                        id
                    } else {
                        str_or_empty(&field("email"))
                    }
                }
            };
            let mut p = build_profile(key, subject, Some(tokens));
            p.email = email;
            p.email_verified = Some(bool_or_undefined(&field("email_verified")).unwrap_or(false));
            p.first_name = str_opt(&field("given_name"))
                .or_else(|| str_opt(&field("first_name")))
                .or_else(|| str_opt(&field("name")));
            p.last_name = str_opt(&field("family_name")).or_else(|| str_opt(&field("last_name")));
            p.username =
                str_opt(&field("preferred_username")).or_else(|| str_opt(&field("username")));
            p.image_url = str_opt(&field("picture")).or_else(|| str_opt(&field("avatar_url")));
            p
        }
    };
    profile.raw = Some(data.clone());
    profile
}
