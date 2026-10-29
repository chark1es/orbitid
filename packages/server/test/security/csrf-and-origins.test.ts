// Cross-site request protection beyond the Frontend API, and the split between "may be redirected to" and "may call".
import { describe, expect, it } from "vitest";
import { insertClientSession, insertUser, setup } from "../machine/helpers";
import { signUpUser, setup as coreSetup, testClient } from "../core/helpers";

describe("consent is protected from cross-site posts", () => {
  it("refuses a cross-site POST to /oauth/consent and a literal null origin, allows the app origin", async () => {
    const h = await setup();
    const user = await insertUser(h.ctx, { email: "consent@example.com" });
    const session = await insertClientSession(h.ctx, user.userId);
    const post = (headers: Record<string, string>) =>
      h.app.request("/oauth/consent", {
        method: "POST",
        headers: { cookie: session.cookie, "content-type": "application/json", ...headers },
        body: JSON.stringify({ client_id: "nope", approve: true }),
      });
    expect((await post({ origin: "https://evil.example", "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await post({ origin: "null" })).status).toBe(403);
    // The app's own origin passes the guard (the request then fails on the unknown client, not on origin).
    expect((await post({ origin: "http://localhost:3000" })).status).not.toBe(403);
  });
});

describe("a null Origin is not a trusted application", () => {
  it("is refused on cookie-authenticated writes to the Frontend API", async () => {
    const { app } = await coreSetup();
    const user = await signUpUser(app);
    const res = await user.client.request("/v1/client/me/api_keys", {
      method: "POST",
      headers: { origin: "null", "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("redirect-only origins never get API access", () => {
  async function instanceWithPartner() {
    const { app, ctx } = await coreSetup();
    await ctx.settings.update({ application: { allowedRedirectOrigins: ["https://partner.example"], allowedOrigins: ["http://localhost:3000"], developmentMode: false } });
    return { app, ctx };
  }

  it("gets no CORS grant and cannot make credentialed writes", async () => {
    const { app } = await instanceWithPartner();
    const user = await signUpUser(app);
    const preflight = await app.request("/v1/client", { method: "OPTIONS", headers: { origin: "https://partner.example", "access-control-request-method": "GET" } });
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    const read = await user.client.request("/v1/client", { headers: { origin: "https://partner.example" } });
    expect(read.headers.get("access-control-allow-origin")).toBeNull();
    const write = await user.client.request("/v1/client/me/api_keys", {
      method: "POST",
      headers: { origin: "https://partner.example", "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(write.status).toBe(403);
  });

  it("does not receive a session token from the handshake", async () => {
    const { app } = await instanceWithPartner();
    const user = await signUpUser(app);
    const denied = await user.client.request("/v1/client/handshake?redirect_url=https://partner.example/x");
    expect(denied.status).toBe(400);
    const allowed = await user.client.request("/v1/client/handshake?redirect_url=http://localhost:3000/x");
    expect(allowed.status).toBe(302);
    expect(allowed.headers.get("location")).toContain("__orbit_handshake=");
  });

  it("still lets an app origin through", async () => {
    const { app } = await instanceWithPartner();
    const user = await signUpUser(app);
    const read = await user.client.request("/v1/client", { headers: { origin: "http://localhost:3000" } });
    expect(read.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
  });
});

describe("token responses are not cached", () => {
  it("sends no-store on OAuth endpoints but keeps the key set cacheable", async () => {
    const h = await setup();
    const token = await h.app.request("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=authorization_code" });
    expect(token.headers.get("cache-control")).toBe("no-store");
    const userinfo = await h.app.request("/oauth/userinfo", { headers: { authorization: "Bearer nope" } });
    expect(userinfo.headers.get("cache-control")).toBe("no-store");
    const jwks = await h.app.request("/oauth/jwks");
    expect(jwks.headers.get("cache-control")).not.toBe("no-store");
  });
});

describe("guest accounts follow the sign-up restrictions", () => {
  it("does not become a member by setting a password alone", async () => {
    const { app, ctx } = await coreSetup();
    await ctx.settings.update({ anonymous: { enabled: true }, restrictions: { allowlistEnabled: true } });
    const guest = testClient(app);
    const created = await guest.json<{ response: { status: string } }>("/v1/client/sign_ups", { body: { strategy: "anonymous" } });
    expect(created.response.status).toBe("complete");

    const password = await guest.request("/v1/client/me/change_password", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ new_password: "Sup3rSecret!" }),
    });
    expect(password.status).toBe(422);
    const me = await guest.json<{ response: { is_anonymous: boolean } }>("/v1/client/me");
    expect(me.response.is_anonymous).toBe(true);

  });
});
