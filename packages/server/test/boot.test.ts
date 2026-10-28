import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { createContext } from "../src/bootstrap";

/** Helper other tests can copy: in-memory instance with fixed keys. */
export async function testApp() {
  const ctx = await createContext({ databasePath: ":memory:", secretKey: "sk_test_testsecret", baseUrl: "http://localhost:4000" });
  return { ctx, app: createApp(ctx) };
}

describe("boot", () => {
  it("serves /health and enforces the secret key on the backend API", async () => {
    const { app, ctx } = await testApp();
    const h = await app.request("/health");
    expect(h.status).toBe(200);
    expect((await h.json()).publishable_key).toBe(ctx.publishableKey);
    const r = await app.request("/v1/users");
    expect(r.status).toBe(401);
    expect((await r.json()).errors[0].code).toBe("secret_key_invalid");
  });
});
