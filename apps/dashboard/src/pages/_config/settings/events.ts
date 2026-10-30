import { WEBHOOK_EVENT_TYPES } from "@orbitid/shared";

const RESOURCE_LABELS: Record<string, string> = {
  user: "Users",
  session: "Sessions",
  email: "Emails",
  sms: "SMS",
  organization: "Organizations",
  organizationMembership: "Organization memberships",
  organizationInvitation: "Organization invitations",
  organizationDomain: "Organization domains",
  role: "Roles",
  permission: "Permissions",
  waitlistEntry: "Waitlist entries",
  invitation: "Invitations",
  apiKey: "API keys",
};

export interface WebhookEventGroup {
  resource: string;
  label: string;
  events: string[];
}

/** Group event types by resource in the declared order of `WEBHOOK_EVENT_TYPES`. */
export function groupWebhookEvents(types: readonly string[] = WEBHOOK_EVENT_TYPES): WebhookEventGroup[] {
  const groups = new Map<string, string[]>();
  for (const type of types) {
    const resource = type.split(".")[0]!;
    const bucket = groups.get(resource);
    if (bucket) bucket.push(type);
    else groups.set(resource, [type]);
  }
  return [...groups.entries()].map(([resource, events]) => ({
    resource,
    label: RESOURCE_LABELS[resource] ?? resource.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase()),
    events,
  }));
}

export function describeWebhookEvent(type: string): string {
  const action = type.split(".")[1] ?? "";
  return action.replace(/_/g, " ");
}

/* ------------------------------------------------------------------------------------------------
 * JWT template shortcodes + local preview
 * ---------------------------------------------------------------------------------------------- */
