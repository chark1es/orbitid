import { describe, expect, it } from "vitest";
import { COOKIES } from "@orbitid/shared";
import { setup, signUpUser, testClient } from "../core/helpers";

describe("CSRF protection for the cookie-authenticated Frontend API", () => {
  it("refuses a cross-site state change that carries the client cookie", async () => {
    const { app, ctx } = await setup();
    const user = await signUpUser(app);

    const res = await user.client.request("/v1/client/me", {
      method: "PATCH",
      body: { first_name: "Mallory" },
      headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).errors[0].code).toBe("not_allowed_access");
    const row = (await ctx.db.select().from((await import("../../src/db/schema")).users))[0]!;
    expect(row.firstName).not.toBe("Mallory");
  });

  it("allows a request from a configured origin", async () => {
    const { app, ctx } = await setup();
    await ctx.settings.update({ application: { allowedOrigins: ["https://app.example.com"] } });
    const user = await signUpUser(app);

    const res = await user.client.request("/v1/client/me", {
      method: "PATCH",
      body: { first_name: "Ada" },
      headers: { origin: "https://app.example.com", "sec-fetch-site": "same-site" },
    });
    expect(res.status).toBe(200);
  });

  it("allows same-origin requests (this server's own base URL)", async () => {
    const { app } = await setup();
    const user = await signUpUser(app);
    const res = await user.client.request("/v1/client/me", {
      method: "PATCH",
      body: { first_name: "Ada" },
      headers: { origin: "http://localhost:4000", "sec-fetch-site": "same-origin" },
    });
    expect(res.status).toBe(200);
  });

  it("falls back to Referer when Origin is absent", async () => {
    const { app } = await setup();
    const user = await signUpUser(app);
    const bad = await user.client.request("/v1/client/me", {
      method: "PATCH",
      body: { first_name: "Mallory" },
      headers: { referer: "https://evil.example/form", "sec-fetch-site": "cross-site" },
    });
    expect(bad.status).toBe(403);

    const good = await user.client.request("/v1/client/me", {
      method: "PATCH",
      body: { first_name: "Ada" },
      headers: { referer: "http://localhost:4000/settings" },
    });
    expect(good.status).toBe(200);
  });

  it("refuses a cross-site POST flagged by Sec-Fetch-Site even without an Origin", async () => {
    const { app } = await setup();
    const user = await signUpUser(app);
    const res = await user.client.request("/v1/client/me/change_password", {
      method: "POST",
      body: { current_password: user.password, new_password: "Another!Passw0rd" },
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(res.status).toBe(403);
  });

  it("leaves GET requests and requests without the client cookie alone", async () => {
    const { app } = await setup();
    const user = await signUpUser(app);
    expect((await user.client.request("/v1/client/me", { headers: { origin: "https://evil.example" } })).status).toBe(200);

    // Bearer tokens are not ambient credentials, so they are not CSRF-able.
    const bearerOnly = testClient(app);
    const state = await bearerOnly.request("/v1/client");
    expect(state.status).toBe(200);
    const token = /__client=([^;]+)/.exec(bearerOnly.cookie ?? "")?.[1];
    expect(token).toBeTruthy();
    const res = await app.request("/v1/client/me", {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ first_name: "Ada" }),
    });
    // No `__client` cookie: the CSRF guard does not apply. (401 is fine: that client has no session.)
    expect(res.status).not.toBe(403);
  });

  it("treats another instance origin as untrusted in production mode", async () => {
    const { app, ctx } = await setup({ nodeEnv: "production", secretKey: "sk_test_production_0123456789abcdef", encryptionKey: "p".repeat(40), baseUrl: "https://auth.example.com" });
    const client = testClient(app);
    await client.request("/v1/client");
    const res = await client.request("/v1/client", {
      method: "POST",
      body: { identifier: "someone@example.com" },
      headers: { origin: "http://localhost:5173", "sec-fetch-site": "cross-site" },
    });
    expect(res.status).toBe(403);
    expect(ctx.settings.get().application.developmentMode).toBe(false);
  });
});

describe("cookie attributes", () => {
  it("sets the client cookie httpOnly, Lax and Path=/", async () => {
    const { app } = await setup();
    const res = await app.request("/v1/client");
    const cookie = res.headers.getSetCookie().find((line) => line.startsWith(`${COOKIES.client}=`));
    expect(cookie).toBeTruthy();
    expect(cookie!).toMatch(/httponly/i);
    expect(cookie!).toMatch(/samesite=lax/i);
    expect(cookie!).toMatch(/path=\//i);
    // Plain-http development cannot use Secure (the browser would drop the cookie).
    expect(cookie!).not.toMatch(/secure/i);
  });

  it("adds Secure to the client cookie over https", async () => {
    const { app } = await setup({ baseUrl: "https://auth.example.com", encryptionKey: "s".repeat(40) });
    const res = await app.request("/v1/client");
    const cookie = res.headers.getSetCookie().find((line) => line.startsWith(`${COOKIES.client}=`));
    expect(cookie!).toMatch(/secure/i);
    expect(cookie!).toMatch(/httponly/i);
  });

  it("keeps the OAuth browser-binding cookie httpOnly and same-site appropriate", async () => {
    const { app, ctx } = await setup({ baseUrl: "https://auth.example.com", encryptionKey: "o".repeat(40) });
    await ctx.settings.update({ social: { google: { enabled: true, clientId: "id", clientSecret: "secret" } } });
    const client = testClient(app);
    await client.request("/v1/client");
    const started = await client.request("/v1/client/sign_ins", { body: { strategy: "oauth_google" } });
    expect(started.status).toBe(200);
    const binding = started.headers.getSetCookie().find((line) => line.startsWith("__orbit_oauth="));
    expect(binding).toBeTruthy();
    expect(binding!).toMatch(/httponly/i);
    expect(binding!).toMatch(/secure/i);
    expect(binding!).toMatch(/samesite=none/i);
    expect(binding!).toMatch(/path=\/v1/i);
  });

  it("clears the client cookie on sign-out without leaving a value behind", async () => {
    const { app } = await setup();
    const client = testClient(app);
    await client.request("/v1/client");
    const res = await client.request("/v1/client", { method: "DELETE" });
    const cleared = res.headers.getSetCookie().find((line) => line.startsWith(`${COOKIES.client}=`));
    expect(cleared).toMatch(/max-age=0/i);
  });
});
