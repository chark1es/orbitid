import { afterEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { createOrbitId } from "../src/client";
import { OrbitIdError } from "../src/errors";
import { startRealServer, backend, type RealServer } from "./helpers/server";
import { MiniApp, http } from "./helpers/mini-app";

let server: RealServer | null = null;
let app: MiniApp | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
  await server?.close();
  server = null;
});

const EVENT = {
  id: "evt_1",
  object: "event",
  type: "user.created",
  timestamp: 1_700_000_000_000,
  instance_id: "ins_1",
  data: { id: "user_1", object: "user" },
};

function rawSecretSecret(base64: string): string {
  return `whsec_${base64}`;
}

function sign(id: string, timestamp: number, body: string, secret: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

/** Registers a real endpoint through the Backend API so the secret is genuine. */
async function webhookSecret(target: RealServer): Promise<string> {
  const created = await backend(target, "POST", "/v1/webhooks/endpoints", {
    url: "https://app.example.com/api/webhooks",
    description: "node sdk test",
    event_types: ["user.created"],
  });
  if (created.status !== 200 && created.status !== 201) throw new Error(`endpoint create failed: ${created.status} ${JSON.stringify(created.body)}`);
  return (created.body as { secret: string }).secret;
}

describe("webhooks.verify", () => {
  it("verifies a delivery signed with the endpoint's real secret", async () => {
    server = await startRealServer();
    const secret = await webhookSecret(server);
    const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url, webhookSecret: secret });

    const body = JSON.stringify(EVENT);
    const timestamp = Math.floor(Date.now() / 1000);
    const headers = {
      "svix-id": "msg_1",
      "svix-timestamp": String(timestamp),
      "svix-signature": sign("msg_1", timestamp, body, secret),
    };

    const event = await orbit.webhooks.verify<{ id: string }>(body, headers);
    expect(event.type).toBe("user.created");
    expect(event.data).toEqual({ id: "user_1", object: "user" });
  });

  it("accepts Uint8Array bodies (express.raw / Node buffers)", async () => {
    server = await startRealServer();
    const secret = await webhookSecret(server);
    const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url });
    const body = JSON.stringify(EVENT);
    const timestamp = Math.floor(Date.now() / 1000);
    const headers = { "svix-id": "msg_1", "svix-timestamp": String(timestamp), "svix-signature": sign("msg_1", timestamp, body, secret) };
    await expect(orbit.webhooks.verify(new TextEncoder().encode(body), headers, secret)).resolves.toMatchObject({ type: "user.created" });
  });

  it("rejects a tampered body", async () => {
    server = await startRealServer();
    const secret = await webhookSecret(server);
    const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url, webhookSecret: secret });
    const body = JSON.stringify(EVENT);
    const timestamp = Math.floor(Date.now() / 1000);
    const headers = { "svix-id": "msg_1", "svix-timestamp": String(timestamp), "svix-signature": sign("msg_1", timestamp, body, secret) };
    const tampered = body.replace("user_1", "user_2");
    await expect(orbit.webhooks.verify(tampered, headers)).rejects.toMatchObject({ code: "webhook_verification_failed", reason: "webhook-verification-failed", status: 400 });
  });

  it("rejects a delivery signed with a different secret", async () => {
    server = await startRealServer();
    const secret = await webhookSecret(server);
    const wrong = rawSecretSecret(Buffer.from("a-different-signing-secret").toString("base64"));
    const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url, webhookSecret: secret });
    const body = JSON.stringify(EVENT);
    const timestamp = Math.floor(Date.now() / 1000);
    const headers = { "svix-id": "msg_1", "svix-timestamp": String(timestamp), "svix-signature": sign("msg_1", timestamp, body, wrong) };
    await expect(orbit.webhooks.verify(body, headers)).rejects.toBeInstanceOf(OrbitIdError);
  });

  it("rejects an old delivery outside the 5-minute tolerance", async () => {
    server = await startRealServer();
    const secret = await webhookSecret(server);
    const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url, webhookSecret: secret });
    const body = JSON.stringify(EVENT);
    const stale = Math.floor(Date.now() / 1000) - 6 * 60;
    const headers = { "svix-id": "msg_1", "svix-timestamp": String(stale), "svix-signature": sign("msg_1", stale, body, secret) };
    await expect(orbit.webhooks.verify(body, headers)).rejects.toMatchObject({ code: "webhook_verification_failed" });
  });

  it("rejects a delivery with missing headers", async () => {
    server = await startRealServer();
    const secret = await webhookSecret(server);
    const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url, webhookSecret: secret });
    await expect(orbit.webhooks.verify(JSON.stringify(EVENT), {})).rejects.toMatchObject({ code: "webhook_verification_failed" });
  });

  it("fails with a configuration error when no secret is available", async () => {
    const orbit = createOrbitId({ secretKey: "sk_test_abc12345", apiUrl: "https://auth.example.com" });
    await expect(orbit.webhooks.verify(JSON.stringify(EVENT), {})).rejects.toMatchObject({ code: "webhook_secret_missing", reason: "configuration" });
  });

  it("accepts a per-call secret override", async () => {
    server = await startRealServer();
    const secret = await webhookSecret(server);
    const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url });
    const body = JSON.stringify(EVENT);
    const timestamp = Math.floor(Date.now() / 1000);
    const headers = { "svix-id": "msg_1", "svix-timestamp": String(timestamp), "svix-signature": sign("msg_1", timestamp, body, secret) };
    await expect(orbit.webhooks.verify(body, headers, secret)).resolves.toMatchObject({ type: "user.created" });
  });
});

describe("webhookHandler (Express)", () => {
  it("verifies the raw body, calls the handler and answers 200", async () => {
    server = await startRealServer();
    const secret = await webhookSecret(server);
    const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url, webhookSecret: secret });
    const received: string[] = [];

    app = new MiniApp();
    app.post("/api/webhooks", orbit.webhookHandler(async (event) => {
      received.push(event.type);
    }));
    await app.listen();

    const body = JSON.stringify(EVENT);
    const timestamp = Math.floor(Date.now() / 1000);
    const response = await http(`${app.url}/api/webhooks`, {
      method: "POST",
      headers: { "content-type": "application/json", "svix-id": "msg_1", "svix-timestamp": String(timestamp), "svix-signature": sign("msg_1", timestamp, body, secret) },
      body,
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true });
    expect(received).toEqual(["user.created"]);
  });

  it("answers 400 for a tampered delivery and does not call the handler", async () => {
    server = await startRealServer();
    const secret = await webhookSecret(server);
    const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url, webhookSecret: secret });
    let called = false;

    app = new MiniApp();
    app.post("/api/webhooks", orbit.webhookHandler(() => {
      called = true;
    }));
    await app.listen();

    const body = JSON.stringify(EVENT);
    const timestamp = Math.floor(Date.now() / 1000);
    const response = await http(`${app.url}/api/webhooks`, {
      method: "POST",
      headers: { "content-type": "application/json", "svix-id": "msg_1", "svix-timestamp": String(timestamp), "svix-signature": sign("msg_1", timestamp, body, secret) },
      body: body.replace("user_1", "user_evil"),
    });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ errors: [{ code: "webhook_verification_failed", message: "The webhook payload could not be verified" }] });
    expect(called).toBe(false);
  });

  it("refuses to run without a raw body and says how to fix it", async () => {
    const orbit = createOrbitId({ secretKey: "sk_test_abc12345", apiUrl: "https://auth.example.com", webhookSecret: "whsec_YQ==" });
    const failures: unknown[] = [];

    // A JSON body parser would leave an object here; the router hands over raw bytes, so simulate
    // the mistake with a first handler that replaces the body.
    app = new MiniApp();
    app.post(
      "/api/webhooks",
      (_req, _res) => undefined,
      (req, _res) => {
        req.body = { type: "user.created" };
      },
      orbit.webhookHandler(() => undefined, { onError: (error) => failures.push(error) }),
    );
    await app.listen();

    const response = await http(`${app.url}/api/webhooks`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(response.status).toBe(400);
    expect(failures).toHaveLength(1);
    expect((failures[0] as OrbitIdError).code).toBe("webhook_raw_body_missing");
    expect((failures[0] as Error).message).toContain("raw");
  });
});
