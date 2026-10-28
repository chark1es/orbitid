// OWNER: worker "admin" (W3) — Backend API: /v1/webhooks/*
import { Hono } from "hono";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  ErrorCodes, ID_PREFIX, OrbitError, WEBHOOK_EVENT_TYPES,
  type WebhookDeliveryJSON, type WebhookEvent,
} from "@orbitid/shared";
import { parseBody } from "../lib/http";
import { newId } from "../lib/ids";
import * as s from "../db/schema";
import { deliverDue, generateWebhookSecret, serializeWebhookDelivery, serializeWebhookEndpoint } from "../services/webhooks";
import { audit } from "../services/audit";
import type { AppContext } from "../context";
import { bool, deleted, listParams, page, parseOrderBy } from "./admin/shared";

const eventTypeSchema = z.enum(WEBHOOK_EVENT_TYPES);
const urlSchema = z.string().url();

function endpointOrThrow(ctx: AppContext, id: string): typeof s.webhookEndpoints.$inferSelect {
  const row = ctx.db.select().from(s.webhookEndpoints).where(eq(s.webhookEndpoints.id, id)).get();
  if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Webhook endpoint not found.");
  return row;
}

const DELIVERY_ORDER_COLUMNS = { created_at: s.webhookDeliveries.createdAt };
const ENDPOINT_ORDER_COLUMNS = { created_at: s.webhookEndpoints.createdAt, updated_at: s.webhookEndpoints.updatedAt };

/** Delivery JSON with the event type resolved from `webhook_events`. */
function deliveryJson(ctx: AppContext, row: typeof s.webhookDeliveries.$inferSelect): WebhookDeliveryJSON {
  const event = ctx.db.select().from(s.webhookEvents).where(eq(s.webhookEvents.id, row.eventId)).get();
  return serializeWebhookDelivery(row, event?.type ?? "");
}

export default function routes(ctx: AppContext) {
  const app = new Hono();

  app.get("/event_types", (c) => c.json(WEBHOOK_EVENT_TYPES));

  app.get("/endpoints", (c) => {
    const { limit, offset } = listParams(c);
    const rows = ctx.db.select().from(s.webhookEndpoints).orderBy(parseOrderBy(c.req.query("order_by"), ENDPOINT_ORDER_COLUMNS, "-created_at")).limit(limit).offset(offset).all();
    const total = Number(ctx.db.select({ n: sql<number>`count(*)` }).from(s.webhookEndpoints).get()?.n ?? 0);
    return c.json(page(rows.map((row) => serializeWebhookEndpoint(row)), total));
  });

  app.post("/endpoints", async (c) => {
    const body = await parseBody(
      c,
      z.object({
        url: urlSchema,
        description: z.string().max(500).default(""),
        event_types: z.array(eventTypeSchema).default([]),
      }),
    );
    const now = Date.now();
    const row = ctx.db
      .insert(s.webhookEndpoints)
      .values({
        id: newId(ID_PREFIX.webhook),
        url: body.url,
        description: body.description,
        eventTypes: body.event_types,
        secret: generateWebhookSecret(),
        disabled: false,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get()!;
    audit(ctx, { actor: "secret_key", action: "webhook_endpoint.created", targetType: "webhook_endpoint", targetId: row.id, metadata: { url: row.url } });
    return c.json(serializeWebhookEndpoint(row, { secret: true }));
  });

  app.get("/endpoints/:id", (c) => c.json(serializeWebhookEndpoint(endpointOrThrow(ctx, c.req.param("id")))));

  app.get("/endpoints/:id/secret", (c) => {
    const row = endpointOrThrow(ctx, c.req.param("id"));
    return c.json({ object: "webhook_endpoint_secret", id: row.id, secret: row.secret });
  });

  app.patch("/endpoints/:id", async (c) => {
    const existing = endpointOrThrow(ctx, c.req.param("id"));
    const body = await parseBody(
      c,
      z.object({
        url: urlSchema.optional(),
        description: z.string().max(500).optional(),
        event_types: z.array(eventTypeSchema).optional(),
        disabled: bool.optional(),
        rotate_secret: bool.optional(),
      }),
    );
    const patch: Partial<typeof s.webhookEndpoints.$inferInsert> = { updatedAt: Date.now() };
    if (body.url !== undefined) patch.url = body.url;
    if (body.description !== undefined) patch.description = body.description;
    if (body.event_types !== undefined) patch.eventTypes = body.event_types;
    if (body.disabled !== undefined) patch.disabled = body.disabled;
    if (body.rotate_secret) patch.secret = generateWebhookSecret();
    ctx.db.update(s.webhookEndpoints).set(patch).where(eq(s.webhookEndpoints.id, existing.id)).run();
    const updated = endpointOrThrow(ctx, existing.id);
    audit(ctx, { actor: "secret_key", action: "webhook_endpoint.updated", targetType: "webhook_endpoint", targetId: updated.id });
    return c.json(serializeWebhookEndpoint(updated, { secret: !!body.rotate_secret }));
  });

  app.delete("/endpoints/:id", (c) => {
    const existing = endpointOrThrow(ctx, c.req.param("id"));
    ctx.db.delete(s.webhookEndpoints).where(eq(s.webhookEndpoints.id, existing.id)).run();
    audit(ctx, { actor: "secret_key", action: "webhook_endpoint.deleted", targetType: "webhook_endpoint", targetId: existing.id, metadata: { url: existing.url } });
    return c.json(deleted("webhook_endpoint", existing.id));
  });

  app.get("/endpoints/:id/deliveries", (c) => {
    const endpoint = endpointOrThrow(ctx, c.req.param("id"));
    const { limit, offset, order_by } = listParams(c);
    const conds: SQL[] = [eq(s.webhookDeliveries.endpointId, endpoint.id)];
    const status = c.req.query("status");
    if (status) conds.push(eq(s.webhookDeliveries.status, status));
    const where = and(...conds);
    const rows = ctx.db
      .select()
      .from(s.webhookDeliveries)
      .where(where)
      .orderBy(parseOrderBy(order_by, DELIVERY_ORDER_COLUMNS, "-created_at"))
      .limit(limit)
      .offset(offset)
      .all();
    const total = Number(ctx.db.select({ n: sql<number>`count(*)` }).from(s.webhookDeliveries).where(where).get()?.n ?? 0);
    return c.json(page(rows.map((row) => deliveryJson(ctx, row)), total));
  });

  app.post("/deliveries/:id/retry", (c) => {
    const row = ctx.db.select().from(s.webhookDeliveries).where(eq(s.webhookDeliveries.id, c.req.param("id"))).get();
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Webhook delivery not found.");
    ctx.db.update(s.webhookDeliveries).set({ status: "pending", attempt: 0, nextAttemptAt: Date.now(), responseCode: null, responseBody: null }).where(eq(s.webhookDeliveries.id, row.id)).run();
    audit(ctx, { actor: "secret_key", action: "webhook_delivery.retried", targetType: "webhook_delivery", targetId: row.id });
    return c.json(deliveryJson(ctx, ctx.db.select().from(s.webhookDeliveries).where(eq(s.webhookDeliveries.id, row.id)).get()!));
  });

  app.post("/endpoints/:id/test", async (c) => {
    const endpoint = endpointOrThrow(ctx, c.req.param("id"));
    const now = Date.now();
    const eventId = newId(ID_PREFIX.webhookEvent);
    const event: WebhookEvent = {
      id: eventId,
      object: "event",
      type: "user.created",
      data: { object: "webhook_endpoint", id: endpoint.id, url: endpoint.url, test: true },
      timestamp: now,
      instance_id: "default",
    };
    ctx.db.insert(s.webhookEvents).values({ id: eventId, type: event.type, payload: event as unknown as Record<string, unknown> }).run();
    const delivery = ctx.db
      .insert(s.webhookDeliveries)
      .values({ id: newId(ID_PREFIX.delivery), endpointId: endpoint.id, eventId, status: "pending", attempt: 0, nextAttemptAt: now })
      .returning()
      .get()!;
    await deliverDue(ctx);
    return c.json(deliveryJson(ctx, ctx.db.select().from(s.webhookDeliveries).where(eq(s.webhookDeliveries.id, delivery.id)).get()!));
  });

  return app;
}
