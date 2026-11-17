//! JWT templates: the `{{user.first_name}}` shortcode engine, context building
//! and template signing keys, ported from `services/jwt-templates.ts` and the
//! key helpers of `modules/admin/jwt.ts`.

use serde_json::{Map, Value};

use orbitid_core::error::Result;
use orbitid_core::models::{
    EmailAddressRow, JwtTemplateRow, OrganizationMembershipRow, OrganizationRow, PhoneNumberRow,
    SessionRow, UserRow,
};
use orbitid_core::AppState;

mod keys;
mod shortcode;

pub use keys::{
    assert_allowed_claims, generate_template_signing_key, import_template_key,
    template_verification_key, SUPPORTED_SIGNING_ALGORITHMS,
};
pub use shortcode::{
    default_avatar, render_claims_with_context, render_template_value, stringify_shortcode_value,
};

/// Input for [`build_shortcode_context`].
#[derive(Debug, Clone, Default)]
pub struct TemplateRenderInput {
    pub user_id: String,
    pub session_id: Option<String>,
    pub org_id: Option<String>,
}

/// A template resolved to concrete claims and signing options.
#[derive(Debug, Clone)]
pub struct RenderedTemplate {
    pub claims: Map<String, Value>,
    pub lifetime_seconds: i64,
    pub allowed_clock_skew_seconds: i64,
    pub signing_key_enc: Option<String>,
    pub algorithm: String,
}

impl RenderedTemplate {
    pub fn claims_as_map(&self) -> Map<String, Value> {
        self.claims.clone()
    }
}

// ───────────── database-backed rendering ─────────────

async fn permissions_for_role(state: &AppState, role_key: &str) -> Result<Vec<String>> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT p.key FROM roles r \
         JOIN role_permissions rp ON rp.role_id = r.id \
         JOIN permissions p ON p.id = rp.permission_id \
         WHERE r.key = $1",
    )
    .bind(role_key)
    .fetch_all(&state.pool)
    .await?;
    Ok(rows.into_iter().map(|(key,)| key).collect())
}

fn display_name(user: &UserRow, email: Option<&EmailAddressRow>) -> String {
    let name = [user.first_name.as_deref(), user.last_name.as_deref()]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ");
    if !name.is_empty() {
        return name;
    }
    user.username
        .clone()
        .or_else(|| email.map(|email| email.email.clone()))
        .unwrap_or_else(|| user.id.clone())
}

/// Builds the shortcode context from the database, exactly like
/// `buildShortcodeContext`.
pub async fn build_shortcode_context(
    state: &AppState,
    input: TemplateRenderInput,
) -> Result<Value> {
    let user = sqlx::query_as::<_, UserRow>("SELECT * FROM users WHERE id = $1")
        .bind(&input.user_id)
        .fetch_optional(&state.pool)
        .await?;
    let session = match &input.session_id {
        Some(session_id) => {
            sqlx::query_as::<_, SessionRow>("SELECT * FROM sessions WHERE id = $1")
                .bind(session_id)
                .fetch_optional(&state.pool)
                .await?
        }
        None => None,
    };
    let org_id = input.org_id.clone().or_else(|| {
        session
            .as_ref()
            .and_then(|row| row.last_active_organization_id.clone())
    });
    let org = match &org_id {
        Some(org_id) => {
            sqlx::query_as::<_, OrganizationRow>("SELECT * FROM organizations WHERE id = $1")
                .bind(org_id)
                .fetch_optional(&state.pool)
                .await?
        }
        None => None,
    };
    let membership = match &org {
        Some(org) => sqlx::query_as::<_, OrganizationMembershipRow>(
            "SELECT * FROM organization_memberships WHERE organization_id = $1 AND user_id = $2",
        )
        .bind(&org.id)
        .bind(&input.user_id)
        .fetch_optional(&state.pool)
        .await?,
        None => None,
    };
    let email = match user
        .as_ref()
        .and_then(|user| user.primary_email_address_id.clone())
    {
        Some(email_id) => {
            sqlx::query_as::<_, EmailAddressRow>("SELECT * FROM email_addresses WHERE id = $1")
                .bind(email_id)
                .fetch_optional(&state.pool)
                .await?
        }
        None => None,
    };
    let phone = match user
        .as_ref()
        .and_then(|user| user.primary_phone_number_id.clone())
    {
        Some(phone_id) => {
            sqlx::query_as::<_, PhoneNumberRow>("SELECT * FROM phone_numbers WHERE id = $1")
                .bind(phone_id)
                .fetch_optional(&state.pool)
                .await?
        }
        None => None,
    };
    let permissions = match &membership {
        Some(membership) => permissions_for_role(state, &membership.role_key).await?,
        None => Vec::new(),
    };

    let mut root = Map::new();
    if let Some(user) = &user {
        let name = display_name(user, email.as_ref());
        let mut user_value = Map::new();
        user_value.insert("id".into(), Value::String(user.id.clone()));
        user_value.insert("external_id".into(), option_string(&user.external_id));
        user_value.insert("username".into(), option_string(&user.username));
        user_value.insert("first_name".into(), option_string(&user.first_name));
        user_value.insert("last_name".into(), option_string(&user.last_name));
        let full_name = [user.first_name.as_deref(), user.last_name.as_deref()]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" ");
        user_value.insert(
            "full_name".into(),
            Value::String(if full_name.is_empty() {
                user.username.clone().unwrap_or_default()
            } else {
                full_name
            }),
        );
        user_value.insert(
            "primary_email_address".into(),
            email
                .as_ref()
                .map(|email| Value::String(email.email.clone()))
                .unwrap_or(Value::Null),
        );
        user_value.insert(
            "primary_phone_number".into(),
            phone
                .as_ref()
                .map(|phone| Value::String(phone.phone.clone()))
                .unwrap_or(Value::Null),
        );
        user_value.insert(
            "email_verified".into(),
            Value::Bool(email.as_ref().is_some_and(|email| email.verified)),
        );
        user_value.insert(
            "phone_number_verified".into(),
            Value::Bool(phone.as_ref().is_some_and(|phone| phone.verified)),
        );
        user_value.insert(
            "image_url".into(),
            Value::String(
                user.image_url
                    .clone()
                    .unwrap_or_else(|| default_avatar(&name)),
            ),
        );
        user_value.insert("has_image".into(), Value::Bool(user.has_image));
        user_value.insert(
            "public_metadata".into(),
            Value::Object(user.public_metadata.0.clone()),
        );
        user_value.insert(
            "unsafe_metadata".into(),
            Value::Object(user.unsafe_metadata.0.clone()),
        );
        user_value.insert("banned".into(), Value::Bool(user.banned));
        user_value.insert("locked".into(), Value::Bool(user.locked));
        user_value.insert("created_at".into(), Value::from(user.created_at));
        user_value.insert("updated_at".into(), Value::from(user.updated_at));
        user_value.insert("last_sign_in_at".into(), option_i64(user.last_sign_in_at));
        user_value.insert("last_active_at".into(), option_i64(user.last_active_at));
        root.insert("user".into(), Value::Object(user_value));
    }
    if let Some(session) = &session {
        root.insert(
            "session".into(),
            serde_json::json!({
                "id": session.id,
                "status": session.status,
                "actor": session.actor.as_ref().map(|actor| actor.0.clone()),
                "created_at": session.created_at,
            }),
        );
    }
    if let Some(org) = &org {
        root.insert(
            "org".into(),
            serde_json::json!({
                "id": org.id,
                "slug": org.slug,
                "name": org.name,
                "role": membership.as_ref().map(|membership| membership.role_key.clone()),
                "permissions": permissions.clone(),
                "public_metadata": org.public_metadata.0.clone(),
            }),
        );
    }
    if let Some(membership) = &membership {
        root.insert(
            "org_membership".into(),
            serde_json::json!({
                "id": membership.id,
                "role": membership.role_key,
                "permissions": permissions,
                "public_metadata": membership.public_metadata.0.clone(),
            }),
        );
    }
    Ok(Value::Object(root))
}

fn option_string(value: &Option<String>) -> Value {
    value.clone().map(Value::String).unwrap_or(Value::Null)
}

fn option_i64(value: Option<i64>) -> Value {
    value.map(Value::from).unwrap_or(Value::Null)
}

/// Renders a named template. `None` means the template does not exist.
pub async fn render_template_claims(
    state: &AppState,
    template_name: &str,
    input: TemplateRenderInput,
) -> Result<Option<RenderedTemplate>> {
    let template =
        sqlx::query_as::<_, JwtTemplateRow>("SELECT * FROM jwt_templates WHERE name = $1")
            .bind(template_name)
            .fetch_optional(&state.pool)
            .await?;
    let Some(template) = template else {
        return Ok(None);
    };
    let context = build_shortcode_context(state, input).await?;
    let claims = render_claims_with_context(&template.claims.0, &context);
    Ok(Some(RenderedTemplate {
        claims,
        lifetime_seconds: template.lifetime,
        allowed_clock_skew_seconds: template.allowed_clock_skew,
        signing_key_enc: if template.custom_signing_key {
            template.signing_key_enc
        } else {
            None
        },
        algorithm: template.signing_algorithm,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use orbitid_core::error::error_codes;

    #[test]
    fn reserved_claims_are_refused() {
        let mut claims = Map::new();
        claims.insert("roles".into(), Value::String("x".into()));
        let error = assert_allowed_claims(&claims).unwrap_err();
        assert_eq!(error.code, error_codes::FORM_PARAM_VALUE_INVALID);
        assert_eq!(error.meta.unwrap()["param_name"], "claims.roles");
    }
}
