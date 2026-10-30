import type { Kit } from "../kit";
import { sql } from "drizzle-orm";
import { tableBuilders, type Meta } from "./columns";

export type WebhooksTables = ReturnType<typeof webhooksTables>;

export function webhooksTables(kit: Kit) {
  const { table, text, int, bool, json, index, uniqueIndex, primaryKey, ts, created } = tableBuilders(kit);

  const webhookEndpoints = table("webhook_endpoints", {
    id: text("id").primaryKey(),
    url: text("url").notNull(),
    description: text("description").notNull().default(""),
    eventTypes: json<string[]>("event_types").notNull().$defaultFn(() => []), // [] = all
    secret: text("secret").notNull(), // whsec_<base64>
    disabled: bool("disabled").notNull().default(false),
    ...created(),
  });
  const webhookEvents = table("webhook_events", {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    payload: json<Record<string, unknown>>("payload").notNull(),
    createdAt: ts("created_at"),
  });
  const webhookDeliveries = table("webhook_deliveries", {
    id: text("id").primaryKey(),
    endpointId: text("endpoint_id").notNull().references(() => webhookEndpoints.id, { onDelete: "cascade" }),
    eventId: text("event_id").notNull().references(() => webhookEvents.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"), // pending | success | failed
    attempt: int("attempt").notNull().default(0),
    responseCode: int("response_code"),
    responseBody: text("response_body"),
    nextAttemptAt: int("next_attempt_at"),
    createdAt: ts("created_at"),
  }, (t) => [index("wd_due_idx").on(t.status, t.nextAttemptAt)]);

  return { webhookEndpoints, webhookEvents, webhookDeliveries };
}
