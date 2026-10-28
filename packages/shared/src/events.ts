/** Webhook event types. Payload envelope: `{ id, object: "event", type, data, timestamp }`. */
export const WEBHOOK_EVENT_TYPES = [
  "user.created", "user.updated", "user.deleted",
  "session.created", "session.ended", "session.removed", "session.revoked",
  "email.created", "sms.created",
  "organization.created", "organization.updated", "organization.deleted",
  "organizationMembership.created", "organizationMembership.updated", "organizationMembership.deleted",
  "organizationInvitation.created", "organizationInvitation.accepted", "organizationInvitation.revoked",
  "organizationDomain.created", "organizationDomain.updated", "organizationDomain.deleted",
  "role.created", "role.updated", "role.deleted",
  "permission.created", "permission.updated", "permission.deleted",
  "waitlistEntry.created", "waitlistEntry.updated",
  "invitation.created", "invitation.accepted", "invitation.revoked",
  "apiKey.created", "apiKey.revoked",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];
export interface WebhookEvent<T = unknown> {
  id: string;
  object: "event";
  type: WebhookEventType;
  data: T;
  timestamp: number;
  instance_id: string;
}
