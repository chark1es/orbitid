// Second-round review: address squatting, guest cookie rotation, allowlist in public mode, spoofable client address.
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { clientIp } from "../../src/lib/http";
import { errorsOf, setup, signUpUser, testClient } from "../core/helpers";

describe("an unverified claim cannot reserve someone's address", () => {
  it("lets the real owner sign up after another account claimed the address without proving it", async () => {
    const { app } = await setup();
    const squatter = await signUpUser(app, { email: "squatter@example.com" });
    const claim = await squatter.client.json<{ response?: { id: string } }>("/v1/client/me/email_addresses", { body: { email_address: "victim@corp.example" } });
    expect(claim.response?.id).toBeTruthy();

    // The owner is not locked out of signing up with their own address.
    const owner = await signUpUser(app, { email: "victim@corp.example", password: "Sup3rSecret!" });
    expect(owner.userId).not.toBe(squatter.userId);

    // Once the owner verified it, the squatter's claim is gone and cannot be verified.
    const list = await squatter.client.json<{ response: { email_address: string }[] }>("/v1/client/me/email_addresses");
    expect(list.response.map((e) => e.email_address)).not.toContain("victim@corp.example");
  });

  it("still refuses an address another account has verified", async () => {
    const { app } = await setup();
    await signUpUser(app, { email: "taken@example.com" });
    const other = await signUpUser(app, { email: "other@example.com" });
    const res = await other.client.json("/v1/client/me/email_addresses", { body: { email_address: "taken@example.com" } });
    expect(errorsOf(res)[0]?.code).toBe("form_identifier_exists");
  });

  it("signs the verified owner in even while an unverified claim exists", async () => {
    const { app } = await setup();
    const owner = await signUpUser(app, { email: "real@example.com", password: "Sup3rSecret!" });
    const squatter = await signUpUser(app, { email: "mallory@example.com" });
    await squatter.client.json("/v1/client/me/email_addresses", { body: { email_address: "real@example.com" } });
    const client = testClient(app);
    const res = await client.json<{ response: { status: string; created_session_id: string | null } }>("/v1/client/sign_ins", { body: { identifier: "real@example.com", password: "Sup3rSecret!" } });
    expect(res.response.created_session_id).toMatch(/^sess_/);
    expect(owner.userId).toBeTruthy();
  });
});

describe("guest sign-up replaces the client cookie", () => {
  it("does not keep a cookie planted before the guest session", async () => {
    const { app, ctx } = await setup();
    await ctx.settings.update({ anonymous: { enabled: true } });
    const browser = testClient(app);
    await browser.request("/v1/client");
    const planted = browser.cookie!;
    await browser.json("/v1/client/sign_ups", { body: { strategy: "anonymous" } });
    expect(browser.cookie).not.toBe(planted);
    expect((await testClient(app, planted).request("/v1/client/me")).status).toBe(401);
  });
});

describe("the allowlist restricts sign-up even in public mode", () => {
  it("refuses an address that is not listed", async () => {
    const { app, ctx } = await setup();
    await ctx.settings.update({ restrictions: { allowlistEnabled: true } });
    const client = testClient(app);
    const res = await client.json("/v1/client/sign_ups", { body: { email_address: "nope@evil.example", password: "Sup3rSecret!" } });
    expect(errorsOf(res)[0]?.code).toBe("sign_up_restricted");
  });
});

describe("the client address is never taken from X-Real-IP", () => {
  it("uses the proxy-appended X-Forwarded-For hop or the socket, and ignores a client-set X-Real-IP", async () => {
    process.env.ORBITID_TRUST_PROXY = "1";
    try {
      const app = new Hono().get("/ip", (c) => c.text(clientIp(c)));
      const spoofed = await (await app.request("/ip", { headers: { "x-real-ip": "6.6.6.6" } })).text();
      expect(spoofed).toBe("127.0.0.1");
      const chained = await (await app.request("/ip", { headers: { "x-forwarded-for": "6.6.6.6, 198.51.100.4", "x-real-ip": "7.7.7.7" } })).text();
      expect(chained).toBe("198.51.100.4");
    } finally {
      delete process.env.ORBITID_TRUST_PROXY;
    }
  });
});
