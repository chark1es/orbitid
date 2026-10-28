import { afterEach, describe, expect, it } from "vitest";
import { createOrbitId } from "../src/client";
import { startRealServer, createUserWithSession, backend, type RealServer } from "./helpers/server";

let server: RealServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

describe("m2m.verify", () => {
  it("verifies an opaque machine token issued by the real server", async () => {
    server = await startRealServer();
    const user = await createUserWithSession(server);
    const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url });

    const machine = await orbit.client.m2m.machines.createMachine({ name: "worker-1" });
    const created = await orbit.client.m2m.tokens.createToken({ machineId: machine.id });
    expect(created.token).toMatch(/^mt_/);

    const verification = await orbit.m2m.verify(created.token!);
    expect(verification.valid).toBe(true);
    expect(verification.machineId).toBe(machine.id);
    expect(verification.machine.id).toBe(machine.id);
    expect(verification.revoked).toBe(false);
    void user;
  });

  it("verifies a JWT machine token", async () => {
    server = await startRealServer();
    const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url });
    const machine = await orbit.client.m2m.machines.createMachine({ name: "worker-jwt" });
    const created = await orbit.client.m2m.tokens.createToken({ machineId: machine.id, tokenFormat: "jwt" });
    const verification = await orbit.m2m.verify(created.token!);
    expect(verification.valid).toBe(true);
    expect(verification.machineId).toBe(machine.id);
  });

  it("refuses an unknown token with a typed error", async () => {
    server = await startRealServer();
    const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url });
    await expect(orbit.m2m.verify("mt_not_a_real_token")).rejects.toMatchObject({ status: 401, code: "authorization_invalid" });
  });

  it("refuses a revoked token", async () => {
    server = await startRealServer();
    const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url });
    const machine = await orbit.client.m2m.machines.createMachine({ name: "worker-revoked" });
    const created = await orbit.client.m2m.tokens.createToken({ machineId: machine.id });
    await orbit.client.m2m.tokens.revokeToken(created.id);
    await expect(orbit.m2m.verify(created.token!)).rejects.toMatchObject({ status: 401, code: "authorization_invalid" });
  });
});

describe("apiKeys.verify", () => {
  it("verifies a key created through the Backend API", async () => {
    server = await startRealServer();
    const user = await createUserWithSession(server);
    const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url });

    const created = await orbit.client.apiKeys.createApiKey({ name: "ci", subject: user.userId, scopes: ["read"] });
    expect(created.secret).toMatch(/^ak_live_|^ak_test_/);

    const verified = await orbit.apiKeys.verify(created.secret!);
    expect(verified.id).toBe(created.id);
    expect(verified.subject).toBe(user.userId);
    expect(verified.scopes).toEqual(["read"]);
    expect(verified.revoked).toBe(false);
  });

  it("refuses an unknown key", async () => {
    server = await startRealServer();
    const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url });
    await expect(orbit.apiKeys.verify("ak_live_nope")).rejects.toMatchObject({ status: 401, code: "api_key_invalid" });
  });

  it("refuses a revoked key", async () => {
    server = await startRealServer();
    const user = await createUserWithSession(server);
    const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url });
    const created = await orbit.client.apiKeys.createApiKey({ name: "ci", subject: user.userId });
    await orbit.client.apiKeys.revokeApiKey(created.id);
    await expect(orbit.apiKeys.verify(created.secret!)).rejects.toMatchObject({ status: 401, code: "api_key_invalid" });
  });

  it("refuses an expired key", async () => {
    server = await startRealServer();
    const user = await createUserWithSession(server);
    const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url });
    // The smallest allowed lifetime is one second; create it through the API so the secret is real.
    const created = await orbit.client.apiKeys.createApiKey({ name: "short", subject: user.userId, secondsUntilExpiration: 1 });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expect(orbit.apiKeys.verify(created.secret!)).rejects.toMatchObject({ code: "api_key_invalid" });
  });

  it("is reachable through the typed client as well", async () => {
    server = await startRealServer();
    const user = await createUserWithSession(server);
    const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url });
    const created = await orbit.client.apiKeys.createApiKey({ name: "cli", subject: user.userId });
    const verified = await orbit.client.apiKeys.verifyApiKey({ secret: created.secret! });
    expect(verified.id).toBe(created.id);
    const raw = await backend(server, "POST", "/v1/api_keys/verify", { secret: created.secret });
    expect(raw.status).toBe(200);
  });
});

describe("client API", () => {
  it("exposes the typed Backend API client for user management", async () => {
    server = await startRealServer();
    const user = await createUserWithSession(server);
    const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url });

    const list = await orbit.client.users.getUserList({ query: user.email });
    expect(list.data.some((entry) => entry.id === user.userId)).toBe(true);
    const fetched = await orbit.client.users.getUser(user.userId);
    expect(fetched.id).toBe(user.userId);
  });
});
