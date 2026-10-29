import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import type { PaginatedList, WebhookDeliveryJSON, WebhookEndpointJSON } from "@orbitid/shared";
import * as s from "../../src/db/schema";
import { deliverDue, emitEvent, signWebhook, verifyWebhookSignature } from "../../src/services/webhooks";
import { createUser, json, testApp } from "./helpers";

interface Received { headers: Record<string, string | string[] | undefined>; body: string }

let server: Server;
let port = 0;
let received: Received[] = [];
let respondWith: number[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    // Ports are reused across test processes; ignore anything that is not a signed webhook request.
    if (!req.headers["svix-id"]) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      const status = respondWith.shift() ?? 200;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: status === 200, echoed: body.length }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  received = [];
  respondWith = [];
});

const hookUrl = () => `http://127.0.0.1:${port}/hook`;

async function forceDue(ctx: Awaited<ReturnType<typeof testApp>>["ctx"], deliveryId: string) {
  await ctx.db.update(s.webhookDeliveries).set({ nextAttemptAt: Date.now() }).where(eq(s.webhookDeliveries.id, deliveryId));
}

async function deliveries(
  api: Awaited<ReturnType<typeof testApp>>["api"],
  endpointId: string,
): Promise<WebhookDeliveryJSON[]> {
  return (await json<PaginatedList<WebhookDeliveryJSON>>(await api("GET", `/v1/webhooks/endpoints/${endpointId}/deliveries`))).data;
}

describe("webhook signing", () => {
  it("produces Svix-compatible signatures that verify and rejects tampering", () => {
    const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
    const body = JSON.stringify({ hello: "world" });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signWebhook(secret, "evt_1", timestamp, body);

    expect(signature.startsWith("v1,")).toBe(true);
    expect(verifyWebhookSignature({ secret, id: "evt_1", timestamp: String(timestamp), body, signature })).toBe(true);
    expect(verifyWebhookSignature({ secret, id: "evt_1", timestamp: String(timestamp), body: `${body} `, signature })).toBe(false);
    expect(verifyWebhookSignature({ secret, id: "evt_2", timestamp: String(timestamp), body, signature })).toBe(false);
    const staleTimestamp = timestamp - 400;
    const staleSignature = signWebhook(secret, "evt_1", staleTimestamp, body);
    expect(verifyWebhookSignature({ secret, id: "evt_1", timestamp: String(staleTimestamp), body, signature: staleSignature })).toBe(false);
    expect(verifyWebhookSignature({ secret, id: "evt_1", timestamp: String(staleTimestamp), body, signature: staleSignature }, { toleranceSeconds: 0 })).toBe(true);
    expect(verifyWebhookSignature({ secret: "whsec_b3RoZXI=", id: "evt_1", timestamp: String(timestamp), body, signature })).toBe(false);
  });
});

describe("webhook delivery", () => {
  it("delivers events with verifiable headers and records the response", async () => {
    const { api, ctx } = await testApp();
    const created = await json<WebhookEndpointJSON>(await api("POST", "/v1/webhooks/endpoints", { url: hookUrl(), description: "tests" }));
    expect(created.secret).toMatch(/^whsec_/);
    expect(created.event_types).toEqual([]);

    const user = await createUser(api, { email_address: ["hooked@example.com"] });
    expect(await deliverDue(ctx)).toBe(1);

    expect(received).toHaveLength(1);
    const request = received[0]!;
    const messageId = request.headers["svix-id"] as string;
    const timestamp = request.headers["svix-timestamp"] as string;
    expect(request.headers["content-type"]).toBe("application/json");
    expect(verifyWebhookSignature({ secret: created.secret!, id: messageId, timestamp, body: request.body, signature: request.headers["svix-signature"] as string })).toBe(true);

    const payload = JSON.parse(request.body) as { object: string; type: string; data: { id: string } };
    expect(payload).toMatchObject({ object: "event", type: "user.created", data: { id: user.id } });
    expect(payload.data.id).toBe(user.id);

    const [delivery] = await deliveries(api, created.id);
    expect(delivery).toMatchObject({ object: "webhook_delivery", endpoint_id: created.id, event_id: messageId, event_type: "user.created", status: "success", attempt: 1, response_code: 200 });
    expect(delivery!.response_body).toContain('"ok":true');
    expect(delivery!.next_attempt_at).toBeNull();
  });

  it("retries failures with the documented backoff until it succeeds", async () => {
    const { api, ctx } = await testApp();
    respondWith = [500, 503, 200];
    const endpoint = await json<WebhookEndpointJSON>(await api("POST", "/v1/webhooks/endpoints", { url: hookUrl() }));
    await createUser(api);

    await deliverDue(ctx);
    let [delivery] = await deliveries(api, endpoint.id);
    expect(delivery).toMatchObject({ status: "pending", attempt: 1, response_code: 500 });
    expect(delivery!.next_attempt_at! - Date.now()).toBeGreaterThan(3_000);
    expect(delivery!.next_attempt_at! - Date.now()).toBeLessThan(6_000);

    await forceDue(ctx, delivery!.id);
    await deliverDue(ctx);
    [delivery] = await deliveries(api, endpoint.id);
    expect(delivery).toMatchObject({ status: "pending", attempt: 2, response_code: 503 });
    expect(delivery!.next_attempt_at! - Date.now()).toBeGreaterThan(290_000);
    expect(delivery!.next_attempt_at! - Date.now()).toBeLessThan(310_000);

    await forceDue(ctx, delivery!.id);
    await deliverDue(ctx);
    [delivery] = await deliveries(api, endpoint.id);
    expect(delivery).toMatchObject({ status: "success", attempt: 3, response_code: 200 });
    expect(received).toHaveLength(3);
  });

  it("gives up after the retry schedule is exhausted", async () => {
    const { api, ctx } = await testApp();
    respondWith = Array.from({ length: 7 }, () => 500);
    const endpoint = await json<WebhookEndpointJSON>(await api("POST", "/v1/webhooks/endpoints", { url: hookUrl() }));
    await createUser(api);
    let [delivery] = await deliveries(api, endpoint.id);

    for (let attempt = 1; attempt <= 7; attempt++) {
      await forceDue(ctx, delivery!.id);
      await deliverDue(ctx);
      [delivery] = await deliveries(api, endpoint.id);
    }

    expect(delivery).toMatchObject({ status: "failed", attempt: 7, response_code: 500 });
    expect(delivery!.next_attempt_at).toBeNull();
    expect(received).toHaveLength(7);
  });

  it("respects event subscriptions and disabled endpoints", async () => {
    const { api, ctx } = await testApp();
    const usersOnly = await json<WebhookEndpointJSON>(await api("POST", "/v1/webhooks/endpoints", { url: `${hookUrl()}?users`, event_types: ["user.created"] }));
    const sessionsOnly = await json<WebhookEndpointJSON>(await api("POST", "/v1/webhooks/endpoints", { url: `${hookUrl()}?sessions`, event_types: ["session.created"] }));
    const disabled = await json<WebhookEndpointJSON>(await api("POST", "/v1/webhooks/endpoints", { url: `${hookUrl()}?off` }));
    await api("PATCH", `/v1/webhooks/endpoints/${disabled.id}`, { disabled: true });

    await createUser(api);
    await deliverDue(ctx);
    expect(received).toHaveLength(1);
    expect((await deliveries(api, usersOnly.id))[0]!.status).toBe("success");
    expect(await deliveries(api, sessionsOnly.id)).toEqual([]);
    expect(await deliveries(api, disabled.id)).toEqual([]);

    await emitEvent(ctx, "session.created", { object: "session", id: "sess_1" });
    await deliverDue(ctx);
    expect(received).toHaveLength(2);

    await api("PATCH", `/v1/webhooks/endpoints/${sessionsOnly.id}`, { disabled: true });
    await emitEvent(ctx, "session.created", { object: "session", id: "sess_2" });
    await deliverDue(ctx);
    expect(received).toHaveLength(2);
    expect(await deliveries(api, sessionsOnly.id)).toHaveLength(1);
  });

  it("sends a sample event from the test endpoint", async () => {
    const { api } = await testApp();
    const endpoint = await json<WebhookEndpointJSON>(await api("POST", "/v1/webhooks/endpoints", { url: hookUrl() }));
    const delivery = await json<WebhookDeliveryJSON>(await api("POST", `/v1/webhooks/endpoints/${endpoint.id}/test`));
    expect(delivery.status).toBe("success");
    expect(delivery.event_type).toBe("user.created");
    expect(received).toHaveLength(1);
    const payload = JSON.parse(received[0]!.body) as { data: { test?: boolean; id: string } };
    expect(payload.data).toMatchObject({ test: true, id: endpoint.id });
  });

  it("records transport failures instead of throwing", async () => {
    const { api, ctx } = await testApp();
    await json<WebhookEndpointJSON>(await api("POST", "/v1/webhooks/endpoints", { url: "http://127.0.0.1:1/unreachable" }));
    await expect(createUser(api)).resolves.toBeTruthy();
    await deliverDue(ctx);
    const [delivery] = await deliveries(api, (await ctx.db.select().from(s.webhookEndpoints))[0]!.id);
    expect(delivery).toMatchObject({ status: "pending", attempt: 1, response_code: null });
    expect(delivery!.response_body).toMatch(/ECONNREFUSED|fetch failed/i);
  });
});

describe("webhook endpoint management", () => {
  it("lists event types, rotates secrets and retries deliveries", async () => {
    const { api, ctx } = await testApp();
    const eventTypes = await json<string[]>(await api("GET", "/v1/webhooks/event_types"));
    expect(eventTypes).toEqual(expect.arrayContaining(["user.created", "user.deleted", "organization.created"]));

    const endpoint = await json<WebhookEndpointJSON>(await api("POST", "/v1/webhooks/endpoints", { url: hookUrl(), description: "first" }));
    expect((await json<WebhookEndpointJSON>(await api("GET", `/v1/webhooks/endpoints/${endpoint.id}`))).secret).toBeUndefined();
    expect((await json<{ secret: string }>(await api("GET", `/v1/webhooks/endpoints/${endpoint.id}/secret`))).secret).toBe(endpoint.secret);

    const rotated = await json<WebhookEndpointJSON>(await api("PATCH", `/v1/webhooks/endpoints/${endpoint.id}`, { rotate_secret: true, description: "rotated" }));
    expect(rotated.secret).toMatch(/^whsec_/);
    expect(rotated.secret).not.toBe(endpoint.secret);
    expect(rotated.description).toBe("rotated");

    expect((await api("POST", "/v1/webhooks/endpoints", { url: "nope" })).status).toBe(422);
    expect((await api("POST", "/v1/webhooks/endpoints", { url: hookUrl(), event_types: ["user.exploded"] })).status).toBe(422);
    expect((await json<PaginatedList<WebhookEndpointJSON>>(await api("GET", "/v1/webhooks/endpoints"))).total_count).toBe(1);

    respondWith = [500];
    await emitEvent(ctx, "user.created", { object: "user", id: "user_x" });
    await deliverDue(ctx);
    const [failed] = await deliveries(api, endpoint.id);
    expect(failed!.status).toBe("pending");

    const retried = await json<WebhookDeliveryJSON>(await api("POST", `/v1/webhooks/deliveries/${failed!.id}/retry`));
    expect(retried).toMatchObject({ status: "pending", attempt: 0 });
    await deliverDue(ctx);
    expect((await deliveries(api, endpoint.id))[0]!.status).toBe("success");

    expect((await api("POST", "/v1/webhooks/deliveries/whd_nope/retry")).status).toBe(404);
    expect(await json(await api("DELETE", `/v1/webhooks/endpoints/${endpoint.id}`))).toEqual({ object: "webhook_endpoint", id: endpoint.id, deleted: true });
    expect((await api("GET", `/v1/webhooks/endpoints/${endpoint.id}`)).status).toBe(404);
  });
});
