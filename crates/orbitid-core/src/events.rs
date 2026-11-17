//! Webhook event types and the event envelope, ported from
//! `packages/shared/src/events.ts`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const WEBHOOK_EVENT_TYPES: &[&str] = &[
    "user.created",
    "user.updated",
    "user.deleted",
    "session.created",
    "session.ended",
    "session.removed",
    "session.revoked",
    "email.created",
    "sms.created",
    "organization.created",
    "organization.updated",
    "organization.deleted",
    "organizationMembership.created",
    "organizationMembership.updated",
    "organizationMembership.deleted",
    "organizationInvitation.created",
    "organizationInvitation.accepted",
    "organizationInvitation.revoked",
    "organizationDomain.created",
    "organizationDomain.updated",
    "organizationDomain.deleted",
    "role.created",
    "role.updated",
    "role.deleted",
    "permission.created",
    "permission.updated",
    "permission.deleted",
    "waitlistEntry.created",
    "waitlistEntry.updated",
    "invitation.created",
    "invitation.accepted",
    "invitation.revoked",
    "apiKey.created",
    "apiKey.revoked",
];

/// Payload envelope: `{ id, object: "event", type, data, timestamp, instance_id }`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WebhookEvent<T = Value> {
    pub id: String,
    pub object: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub data: T,
    /// Unix epoch milliseconds.
    pub timestamp: i64,
    pub instance_id: String,
}

impl<T> WebhookEvent<T> {
    pub fn new(
        id: String,
        event_type: impl Into<String>,
        data: T,
        timestamp: i64,
        instance_id: String,
    ) -> Self {
        Self {
            id,
            object: "event".to_string(),
            event_type: event_type.into(),
            data,
            timestamp,
            instance_id,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_uses_type_key() {
        let event = WebhookEvent::new(
            "evt_1".into(),
            "user.created",
            serde_json::json!({ "id": "user_1" }),
            1,
            "instance".into(),
        );
        let value = serde_json::to_value(event).unwrap();
        assert_eq!(value["object"], "event");
        assert_eq!(value["type"], "user.created");
        assert_eq!(value["timestamp"], 1);
    }

    #[test]
    fn documented_event_types_are_listed() {
        assert!(WEBHOOK_EVENT_TYPES.contains(&"organizationMembership.created"));
        assert!(WEBHOOK_EVENT_TYPES.contains(&"apiKey.revoked"));
    }
}
