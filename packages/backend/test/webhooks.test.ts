import { describe, expect, it } from "vitest";
import { signWebhook, verifyWebhook, WebhookVerificationError, type WebhookVerificationErrorReason } from "../src/webhooks";

const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const EVENT = { id: "evt_1", object: "event", type: "user.created", data: { id: "user_1" }, timestamp: 1_700_000_000, instance_id: "inst_1" };

async function expectReason(promise: Promise<unknown>, reason: WebhookVerificationErrorReason): Promise<void> {
  const error = await promise.catch((err: unknown) => err);
  expect(error).toBeInstanceOf(WebhookVerificationError);
  expect((error as WebhookVerificationError).reason).toBe(reason);
}

describe("webhooks", () => {
  it("signs and verifies a payload (object form)", async () => {
    const signed = signWebhook(EVENT, { signingSecret: SECRET, id: "msg_1", timestamp: 1_700_000_000 });
    expect(signed.headers["svix-id"]).toBe("msg_1");
    expect(signed.headers["svix-timestamp"]).toBe("1700000000");
    expect(signed.headers["svix-signature"]).toMatch(/^v1,/);

    const event = await verifyWebhook<{ id: string }>({ body: signed.body, headers: signed.headers }, { signingSecret: SECRET, now: () => 1_700_000_000_000 });
    expect(event.type).toBe("user.created");
    expect(event.data.id).toBe("user_1");
    expect(event.instance_id).toBe("inst_1");
  });

  it("verifies a Request without the whsec_ prefix", async () => {
    const signed = signWebhook(EVENT, { signingSecret: SECRET, timestamp: 1_700_000_000 });
    const request = new Request("https://app.example.com/webhooks", { method: "POST", body: signed.body, headers: signed.headers });
    const event = await verifyWebhook(request, { signingSecret: SECRET.replace("whsec_", ""), now: () => 1_700_000_000_000 });
    expect(event.id).toBe("evt_1");
  });

  it("accepts multiple space-separated signatures", async () => {
    const signed = signWebhook(EVENT, { signingSecret: SECRET, id: "msg_2", timestamp: 1_700_000_000 });
    const signature = signed.headers["svix-signature"]!.replace(/^v1,/, "");
    const headers = { ...signed.headers, "svix-signature": `v1,AAAA ${signed.headers["svix-signature"]}` };
    expect(signature.length).toBeGreaterThan(0);
    const event = await verifyWebhook({ body: signed.body, headers }, { signingSecret: SECRET, now: () => 1_700_000_000_000 });
    expect(event.id).toBe("evt_1");
  });

  it("reads plain-object headers case-insensitively", async () => {
    const signed = signWebhook(EVENT, { signingSecret: SECRET, id: "msg_case", timestamp: 1_700_000_000 });
    const headers = {
      "Svix-Id": signed.headers["svix-id"]!,
      "SVIX-TIMESTAMP": signed.headers["svix-timestamp"]!,
      // Some frameworks expose repeated request headers as an array.
      "Svix-Signature": [signed.headers["svix-signature"]!],
    };
    const event = await verifyWebhook({ body: signed.body, headers }, { signingSecret: SECRET, now: () => 1_700_000_000_000 });
    expect(event.id).toBe("evt_1");
  });

  it("treats missing headers as missing, not as a crash", async () => {
    const signed = signWebhook(EVENT, { signingSecret: SECRET, timestamp: 1_700_000_000 });
    await expectReason(
      verifyWebhook({ body: signed.body, headers: null }, { signingSecret: SECRET, now: () => 1_700_000_000_000 }),
      "missing-headers",
    );
    await expectReason(
      verifyWebhook({ body: signed.body, headers: undefined }, { signingSecret: SECRET, now: () => 1_700_000_000_000 }),
      "missing-headers",
    );
  });

  it("rejects tampered bodies and signatures", async () => {
    const signed = signWebhook(EVENT, { signingSecret: SECRET, id: "msg_3", timestamp: 1_700_000_000 });
    await expectReason(
      verifyWebhook({ body: signed.body.replace("user_1", "user_2"), headers: signed.headers }, { signingSecret: SECRET, now: () => 1_700_000_000_000 }),
      "invalid-signature",
    );
    const tamperedSignature = { ...signed.headers, "svix-signature": "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" };
    await expectReason(
      verifyWebhook({ body: signed.body, headers: tamperedSignature }, { signingSecret: SECRET, now: () => 1_700_000_000_000 }),
      "invalid-signature",
    );
    await expectReason(
      verifyWebhook({ body: signed.body, headers: { ...signed.headers, "svix-id": "msg_other" } }, { signingSecret: SECRET, now: () => 1_700_000_000_000 }),
      "invalid-signature",
    );
  });

  it("enforces the replay window", async () => {
    const signed = signWebhook(EVENT, { signingSecret: SECRET, id: "msg_4", timestamp: 1_700_000_000 });
    await expectReason(
      verifyWebhook({ body: signed.body, headers: signed.headers }, { signingSecret: SECRET, now: () => (1_700_000_000 + 301) * 1000 }),
      "timestamp-out-of-tolerance",
    );
    await expectReason(
      verifyWebhook({ body: signed.body, headers: signed.headers }, { signingSecret: SECRET, now: () => (1_700_000_000 - 301) * 1000 }),
      "timestamp-out-of-tolerance",
    );
    const event = await verifyWebhook(
      { body: signed.body, headers: signed.headers },
      { signingSecret: SECRET, now: () => (1_700_000_000 + 240) * 1000, toleranceInSeconds: 300 },
    );
    expect(event.id).toBe("evt_1");
  });

  it("rejects missing headers, invalid secrets and invalid payloads", async () => {
    const signed = signWebhook(EVENT, { signingSecret: SECRET, timestamp: 1_700_000_000 });
    await expectReason(
      verifyWebhook({ body: signed.body, headers: { "svix-id": "msg_5" } }, { signingSecret: SECRET, now: () => 1_700_000_000_000 }),
      "missing-headers",
    );
    await expectReason(
      verifyWebhook({ body: signed.body, headers: signed.headers }, { signingSecret: "whsec_", now: () => 1_700_000_000_000 }),
      "invalid-secret",
    );
    const badPayload = signWebhook("not json", { signingSecret: SECRET, timestamp: 1_700_000_000 });
    await expectReason(
      verifyWebhook({ body: badPayload.body, headers: badPayload.headers }, { signingSecret: SECRET, now: () => 1_700_000_000_000 }),
      "invalid-payload",
    );
  });
});
