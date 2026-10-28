// OWNER: worker "admin" (W3). Persist events, fan out deliveries, deliver with retries (Svix-compatible signatures).
import { createHmac, randomBytes } from "node:crypto";
import { and, eq, lte } from "drizzle-orm";
import {
  ID_PREFIX,
  type WebhookDeliveryJSON, type WebhookEndpointJSON, type WebhookEvent, type WebhookEventType,
} from "@orbitid/shared";
import { newId } from "../lib/ids";
import { safeEqual } from "../lib/crypto";
import * as s from "../db/schema";
import type { AppContext } from "../context";

/** Wait between attempts: after failure #1, #2, ... (`5s, 5m, 30m, 2h, 5h, 10h`), then the delivery is marked failed. */
export const WEBHOOK_RETRY_DELAYS_MS = [5_000, 300_000, 1_800_000, 7_200_000, 18_000_000, 36_000_000] as const;
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_DELAYS_MS.length + 1;
const DELIVERY_TIMEOUT_MS = 10_000;
/** While an attempt is in flight the row is parked this far in the future so a second worker tick cannot double-send. */
const CLAIM_WINDOW_MS = 60_000;
const RESPONSE_BODY_LIMIT = 2048;

type EndpointRow = typeof s.webhookEndpoints.$inferSelect;
type DeliveryRow = typeof s.webhookDeliveries.$inferSelect;

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("base64")}`;
}

/** Svix scheme: `v1,<base64 hmac-sha256(secretBytes, "id.timestamp.body")>`; `secret` is `whsec_<base64>`. */
export function signWebhook(secret: string, id: string, timestamp: string | number, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const digest = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
  return `v1,${digest}`;
}

export interface WebhookVerificationInput {
  secret: string;
  id: string | null | undefined;
  timestamp: string | null | undefined;
  body: string;
  /** Raw `svix-signature` header (may contain several space-separated signatures). */
  signature: string | null | undefined;
}

/** Verify a received webhook. `toleranceSeconds` rejects replays (0 disables the timestamp check). */
export function verifyWebhookSignature(
  input: WebhookVerificationInput,
  opts: { toleranceSeconds?: number; now?: number } = {},
): boolean {
  const { secret, id, timestamp, body, signature } = input;
  if (!id || !timestamp || !signature) return false;
  const tolerance = opts.toleranceSeconds ?? 300;
  if (tolerance > 0) {
    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds)) return false;
    const age = Math.abs((opts.now ?? Date.now()) / 1000 - seconds);
    if (age > tolerance) return false;
  }
  const expected = signWebhook(secret, id, timestamp, body).slice("v1,".length);
  return signature.split(" ").some((part) => {
    const [version, value] = part.split(",");
    return version === "v1" && !!value && safeEqual(value, expected);
  });
}

export function serializeWebhookEndpoint(row: EndpointRow, opts: { secret?: boolean } = {}): WebhookEndpointJSON {
  const json: WebhookEndpointJSON = {
    object: "webhook_endpoint",
    id: row.id,
    url: row.url,
    description: row.description,
    event_types: row.eventTypes ?? [],
    disabled: row.disabled,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
  if (opts.secret) json.secret = row.secret;
  return json;
}

export function serializeWebhookDelivery(row: DeliveryRow, eventType: string): WebhookDeliveryJSON {
  return {
    object: "webhook_delivery",
    id: row.id,
    endpoint_id: row.endpointId,
    event_id: row.eventId,
    event_type: eventType,
    status: row.status as WebhookDeliveryJSON["status"],
    attempt: row.attempt,
    response_code: row.responseCode,
    response_body: row.responseBody,
    next_attempt_at: row.nextAttemptAt,
    created_at: row.createdAt,
  };
}

/** Builds the event envelope + pending deliveries for every enabled endpoint subscribed to `type`. MUST NOT throw. */
export async function emitEvent(ctx: AppContext, type: WebhookEventType, data: unknown): Promise<void> {
  try {
    const now = Date.now();
    const eventId = newId(ID_PREFIX.webhookEvent);
    const envelope: WebhookEvent = { id: eventId, object: "event", type, data, timestamp: now, instance_id: "default" };
    ctx.db.insert(s.webhookEvents).values({ id: eventId, type, payload: envelope as unknown as Record<string, unknown> }).run();
    const endpoints = ctx.db.select().from(s.webhookEndpoints).where(eq(s.webhookEndpoints.disabled, false)).all();
    for (const endpoint of endpoints) {
      const types = endpoint.eventTypes ?? [];
      if (types.length && !types.includes(type)) continue;
      ctx.db
        .insert(s.webhookDeliveries)
        .values({ id: newId(ID_PREFIX.delivery), endpointId: endpoint.id, eventId, status: "pending", attempt: 0, nextAttemptAt: now })
        .run();
    }
  } catch (err) {
    console.error("[webhooks] failed to emit", type, err);
  }
}

/** Single attempt against one endpoint; records response code/body, schedules the next retry or marks the delivery failed. */
async function attemptDelivery(ctx: AppContext, delivery: DeliveryRow, endpoint: EndpointRow, event: typeof s.webhookEvents.$inferSelect): Promise<void> {
  const attempt = delivery.attempt + 1;
  const timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify(event.payload);
  let responseCode: number | null = null;
  let responseBody = "";
  let ok = false;
  try {
    const res = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "OrbitID-Webhooks/1.0",
        "svix-id": event.id,
        "svix-timestamp": String(timestamp),
        "svix-signature": signWebhook(endpoint.secret, event.id, timestamp, body),
      },
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    responseCode = res.status;
    responseBody = await res.text();
    ok = res.ok;
  } catch (err) {
    responseBody = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }
  const retryDelay = WEBHOOK_RETRY_DELAYS_MS[attempt - 1];
  const failed = !ok && attempt >= WEBHOOK_MAX_ATTEMPTS;
  ctx.db
    .update(s.webhookDeliveries)
    .set({
      attempt,
      responseCode,
      responseBody: responseBody.slice(0, RESPONSE_BODY_LIMIT),
      status: ok ? "success" : failed ? "failed" : "pending",
      nextAttemptAt: ok || failed ? null : Date.now() + (retryDelay ?? WEBHOOK_RETRY_DELAYS_MS[WEBHOOK_RETRY_DELAYS_MS.length - 1]),
    })
    .where(eq(s.webhookDeliveries.id, delivery.id))
    .run();
}

/**
 * Delivers every due pending delivery (called by the worker loop; exported so tests/schedulers can drive it
 * deterministically). Returns the number of deliveries attempted.
 */
export async function deliverDue(ctx: AppContext, opts: { limit?: number } = {}): Promise<number> {
  const now = Date.now();
  const due = ctx.db
    .select()
    .from(s.webhookDeliveries)
    .where(and(eq(s.webhookDeliveries.status, "pending"), lte(s.webhookDeliveries.nextAttemptAt, now)))
    .limit(opts.limit ?? 20)
    .all();
  let attempted = 0;
  for (const delivery of due) {
    const endpoint = ctx.db.select().from(s.webhookEndpoints).where(eq(s.webhookEndpoints.id, delivery.endpointId)).get();
    const event = ctx.db.select().from(s.webhookEvents).where(eq(s.webhookEvents.id, delivery.eventId)).get();
    if (!endpoint || !event) continue;
    // Claim the row before the network call so overlapping ticks cannot deliver it twice.
    ctx.db.update(s.webhookDeliveries).set({ nextAttemptAt: Date.now() + CLAIM_WINDOW_MS }).where(eq(s.webhookDeliveries.id, delivery.id)).run();
    await attemptDelivery(ctx, delivery, endpoint, event);
    attempted += 1;
  }
  return attempted;
}

export const WEBHOOK_WORKER_INTERVAL_MS = 2_000;

/** Starts the 2s delivery loop; returns `stop()`. Called once by `startServer`. */
export function startWebhookWorker(ctx: AppContext): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await deliverDue(ctx);
    } catch (err) {
      console.error("[webhooks] worker tick failed", err);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(tick, WEBHOOK_WORKER_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
