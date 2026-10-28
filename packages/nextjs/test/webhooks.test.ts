import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebhookVerificationError, verifyWebhook } from "../src/webhooks";

const SECRET_BASE64 = Buffer.from("super-secret-webhook-key").toString("base64");
const SECRET = `whsec_${SECRET_BASE64}`;
const NOW = 1_700_000_000;

function signatureFor(id: string, timestamp: number, body: string, secret = SECRET): string {
  const raw = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return createHmac("sha256", raw).update(`${id}.${timestamp}.${body}`).digest("base64");
}

function webhookRequest(
  body: string,
  options: { id?: string; timestamp?: number; signature?: string } = {},
): Request {
  const id = options.id ?? "msg_1";
  const timestamp = options.timestamp ?? NOW;
  const signature = options.signature ?? signatureFor(id, timestamp, body);
  return new Request("https://app.test/api/webhooks", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": String(timestamp),
      "svix-signature": `v1,${signature}`,
    },
  });
}

const EVENT = {
  id: "evt_1",
  object: "event",
  type: "user.created",
  timestamp: NOW * 1000,
  instance_id: "ins_1",
  data: { id: "user_1" },
};

let originalSecret: string | undefined;

beforeEach(() => {
  originalSecret = process.env.ORBITID_WEBHOOK_SECRET;
  delete process.env.ORBITID_WEBHOOK_SECRET;
});

afterEach(() => {
  if (originalSecret === undefined) delete process.env.ORBITID_WEBHOOK_SECRET;
  else process.env.ORBITID_WEBHOOK_SECRET = originalSecret;
});

describe("verifyWebhook", () => {
  it("verifies a valid Request and returns the parsed event", async () => {
    const body = JSON.stringify(EVENT);
    const event = await verifyWebhook(webhookRequest(body), { secret: SECRET, now: () => NOW * 1000 });
    expect(event.type).toBe("user.created");
    expect(event.data).toEqual({ id: "user_1" });
  });

  it("accepts { body, headers } and multiple signatures", async () => {
    const body = JSON.stringify(EVENT);
    const signature = signatureFor("msg_1", NOW, body);
    const event = await verifyWebhook(
      {
        body,
        headers: {
          "svix-id": "msg_1",
          "svix-timestamp": String(NOW),
          "svix-signature": `v1,invalid v1,${signature}`,
        },
      },
      { secret: SECRET, now: () => NOW * 1000 },
    );
    expect(event.id).toBe("evt_1");
  });

  it("uses ORBITID_WEBHOOK_SECRET by default", async () => {
    process.env.ORBITID_WEBHOOK_SECRET = SECRET;
    const body = JSON.stringify(EVENT);
    const event = await verifyWebhook(webhookRequest(body), { now: () => NOW * 1000 });
    expect(event.type).toBe("user.created");
  });

  it("rejects a tampered body", async () => {
    const body = JSON.stringify(EVENT);
    const request = webhookRequest(body);
    const tampered = new Request("https://app.test/api/webhooks", {
      method: "POST",
      body: JSON.stringify({ ...EVENT, type: "user.deleted" }),
      headers: request.headers,
    });
    await expect(verifyWebhook(tampered, { secret: SECRET, now: () => NOW * 1000 })).rejects.toBeInstanceOf(
      WebhookVerificationError,
    );
  });

  it("rejects a stale timestamp", async () => {
    const body = JSON.stringify(EVENT);
    await expect(
      verifyWebhook(webhookRequest(body), { secret: SECRET, now: () => (NOW + 3600) * 1000 }),
    ).rejects.toMatchObject({ reason: "timestamp-out-of-tolerance" });
  });

  it("rejects missing headers", async () => {
    await expect(
      verifyWebhook({ body: "{}", headers: {} }, { secret: SECRET }),
    ).rejects.toMatchObject({ reason: "missing-headers" });
  });

  it("rejects a missing secret", async () => {
    await expect(verifyWebhook(webhookRequest("{}"))).rejects.toMatchObject({
      reason: "invalid-secret",
    });
  });

  it("rejects invalid JSON after signature verification", async () => {
    const body = "not-json";
    await expect(
      verifyWebhook(webhookRequest(body), { secret: SECRET, now: () => NOW * 1000 }),
    ).rejects.toMatchObject({ reason: "invalid-payload" });
  });
});
