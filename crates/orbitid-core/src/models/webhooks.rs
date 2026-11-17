//! Webhook tables: `webhook_endpoints`, `webhook_events`, `webhook_deliveries`.

use super::{JsonList, Jsonb};

#[derive(Clone, sqlx::FromRow)]
pub struct WebhookEndpointRow {
    pub id: String,
    pub url: String,
    pub description: String,
    /// Empty means "all events".
    pub event_types: JsonList,
    /// `whsec_<base64>`
    pub secret: String,
    pub disabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

impl std::fmt::Debug for WebhookEndpointRow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebhookEndpointRow")
            .field("id", &self.id)
            .field("url", &self.url)
            .field("description", &self.description)
            .field("event_types", &self.event_types)
            .field("secret", &"<redacted>")
            .field("disabled", &self.disabled)
            .field("created_at", &self.created_at)
            .field("updated_at", &self.updated_at)
            .finish()
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct WebhookEventRow {
    pub id: String,
    #[sqlx(rename = "type")]
    pub event_type: String,
    pub payload: Jsonb,
    pub created_at: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct WebhookDeliveryRow {
    pub id: String,
    pub endpoint_id: String,
    pub event_id: String,
    /// `pending` | `success` | `failed`
    pub status: String,
    pub attempt: i64,
    pub response_code: Option<i64>,
    pub response_body: Option<String>,
    pub next_attempt_at: Option<i64>,
    pub created_at: i64,
}
