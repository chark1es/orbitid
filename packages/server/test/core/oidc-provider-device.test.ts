// OIDC provider: device authorization grant and the server-rendered verification page.
import { beforeEach, describe, expect, it } from "vitest";
import { jwtVerify } from "jose";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { BASE_URL, insertClientSession, insertUser, setup } from "../machine/helpers";
import { first } from "../../src/lib/db";
import { createApp, DEVICE_ATTEMPT_BUDGET, form, jwks, json, type Harness } from "./oidc-provider-helpers";
describe("OIDC — device authorization grant", () => {
  let h: Harness;
  let user: Awaited<ReturnType<typeof insertUser>>;
  let session: Awaited<ReturnType<typeof insertClientSession>>;
  let app: { id: string; client_id: string; client_secret?: string };

  beforeEach(async () => {
    h = await setup();
    await h.ctx.settings.update({
      oidcProvider: { deviceAuthorizationEnabled: true, deviceCodeIntervalSeconds: 1, deviceCodeLifetimeSeconds: 60 },
      security: { rateLimitEnabled: false },
    });
    user = await insertUser(h.ctx);
    session = await insertClientSession(h.ctx, user.userId);
    app = await createApp(h) as typeof app;
  });

  async function startDevice(publicClient = false) {
    const client = publicClient ? await createApp(h, { public: true }) as { client_id: string; client_secret?: string } : app;
    const res = await form(h, "/oauth/device_authorization", {
      client_id: client.client_id, scope: "openid email", ...(client.client_secret ? { client_secret: client.client_secret } : {}),
    });
    expect(res.status).toBe(200);
    return { client, body: await res.json() as { device_code: string; user_code: string; verification_uri: string; verification_uri_complete: string; expires_in: number; interval: number } };
  }

  const poll = (deviceCode: string, client: { client_id: string; client_secret?: string }) =>
    form(h, "/oauth/token", {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: client.client_id,
      ...(client.client_secret ? { client_secret: client.client_secret } : {}),
    });

  const approve = (userCode: string, cookie: string | undefined, action: "approve" | "deny" = "approve") =>
    h.app.request("/v1/client/oauth/device/approve", {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: json({ user_code: userCode, action }),
    });

  it("is disabled by default and absent from discovery", async () => {
    const plain = await setup();
    const created = await createApp(plain);
    const res = await form(plain, "/oauth/device_authorization", { client_id: created.client_id, scope: "openid" });
    expect(res.status).toBe(404);
    const doc = await (await plain.app.request("/.well-known/openid-configuration")).json();
    expect(doc.device_authorization_endpoint).toBeUndefined();
    expect(doc.grant_types_supported).not.toContain("urn:ietf:params:oauth:grant-type:device_code");
    const pollRes = await form(plain, "/oauth/token", {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: "odc_x", client_id: created.client_id, client_secret: created.client_secret ?? "",
    });
    expect(pollRes.status).toBe(400);
    expect((await pollRes.json()).error).toBe("unsupported_grant_type");
    // The page and its assets are not served either.
    expect((await plain.app.request("/oauth/device")).status).toBe(404);
  });

  it("walks the whole flow: device code, user approval, token poll", async () => {
    const { body, client } = await startDevice();
    expect(body.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(body.verification_uri).toBe(`${BASE_URL}/oauth/device`);
    expect(body.verification_uri_complete).toContain(`user_code=${encodeURIComponent(body.user_code)}`);
    expect(body.expires_in).toBe(60);
    expect(body.interval).toBe(1);

    const pending = await poll(body.device_code, client);
    expect(pending.status).toBe(400);
    expect((await pending.json()).error).toBe("authorization_pending");

    // The consent view shows the application and what it asks for.
    const info = await h.app.request(`/v1/client/oauth/device?user_code=${encodeURIComponent(body.user_code)}`, { headers: { cookie: session.cookie } });
    expect(info.status).toBe(200);
    const infoBody = await info.json();
    expect(infoBody.client.name).toBe("Test App");
    expect(infoBody.scopes.map((s: { scope: string }) => s.scope)).toEqual(["openid", "email"]);
    expect(infoBody.status).toBe("pending");

    const approved = await approve(body.user_code, session.cookie);
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ status: "approved", user_code: body.user_code });

    await new Promise((r) => setTimeout(r, 1100));
    const tokenRes = await poll(body.device_code, client);
    expect(tokenRes.status).toBe(200);
    const tokens = await tokenRes.json() as { access_token: string; id_token?: string };
    expect(tokens.access_token).toMatch(/^oat_/);
    const { payload } = await jwtVerify(tokens.id_token!, await jwks(h));
    expect(payload).toMatchObject({ sub: user.userId, email: "user@example.com" });

    // The device code is consumed: a replay is an expired_token, never a second token set.
    const replay = await poll(body.device_code, client);
    expect(replay.status).toBe(400);
    expect((await replay.json()).error).toBe("expired_token");
  });

  it("supports public clients without a secret", async () => {
    const { body, client } = await startDevice(true);
    expect(client.client_secret).toBeUndefined();
    await approve(body.user_code, session.cookie);
    await new Promise((r) => setTimeout(r, 1100));
    const tokenRes = await poll(body.device_code, client);
    expect(tokenRes.status).toBe(200);
    expect((await tokenRes.json()).access_token).toMatch(/^oat_/);
  });

  it("applies slow_down and permanently widens the interval", async () => {
    const { body, client } = await startDevice();
    await poll(body.device_code, client);
    const tooFast = await poll(body.device_code, client);
    expect(tooFast.status).toBe(400);
    const tooFastBody = await tooFast.json();
    expect(tooFastBody.error).toBe("slow_down");
    expect(tooFast.headers.get("retry-after")).toBe("6");
    const row = first(await h.ctx.db.select().from(schema.deviceCodes))!;
    expect(row.intervalSeconds).toBe(6);

    await approve(body.user_code, session.cookie);
    // Still inside the new interval.
    const stillFast = await poll(body.device_code, client);
    expect((await stillFast.json()).error).toBe("slow_down");
  });

  it("returns access_denied after a denial and expired_token after expiry", async () => {
    const denied = await startDevice();
    await approve(denied.body.user_code, session.cookie, "deny");
    const deniedPoll = await poll(denied.body.device_code, denied.client);
    expect((await deniedPoll.json()).error).toBe("access_denied");

    const expired = await startDevice();
    await h.ctx.db.update(schema.deviceCodes)
      .set({ expiresAt: Date.now() - 1000 })
      .where(eq(schema.deviceCodes.userCode, expired.body.user_code.replace("-", "")));
    const expiredPoll = await poll(expired.body.device_code, expired.client);
    expect((await expiredPoll.json()).error).toBe("expired_token");
  });

  it("rejects a device code presented by a different client", async () => {
    const { body } = await startDevice();
    const other = await createApp(h, { name: "Other" }) as { client_id: string; client_secret: string };
    const res = await poll(body.device_code, other);
    expect((await res.json()).error).toBe("expired_token");
  });

  it("requires a session to approve, and a code is approved only once", async () => {
    const { body } = await startDevice();
    const signedOut = await approve(body.user_code, undefined);
    expect(signedOut.status).toBe(401);

    const info = await h.app.request(`/v1/client/oauth/device?user_code=${encodeURIComponent(body.user_code)}`);
    expect(info.status).toBe(401);

    expect((await approve(body.user_code, session.cookie)).status).toBe(200);
    // A second approval (by someone else, or by the same user) cannot reuse the decision.
    const second = await approve(body.user_code, session.cookie);
    expect(second.status).toBe(409);
    const otherUser = await signUpAnother(h);
    expect((await approve(body.user_code, otherUser)).status).toBe(409);

    // Once consumed, the code cannot be approved again either.
    await new Promise((r) => setTimeout(r, 1100));
    await poll(body.device_code, { client_id: app.client_id, client_secret: app.client_secret });
    expect((await approve(body.user_code, otherUser)).status).toBe(409);
  });

  async function signUpAnother(h: Harness) {
    const other = await insertUser(h.ctx, { email: "other@example.com" });
    return (await insertClientSession(h.ctx, other.userId)).cookie;
  }

  it("rejects a malformed user code and an unknown one", async () => {
    const bad = await approve("nope", session.cookie);
    expect(bad.status).toBe(422);
    const unknown = await h.app.request("/v1/client/oauth/device?user_code=BCDF-2345", { headers: { cookie: session.cookie } });
    expect(unknown.status).toBe(404);
  });

  it("brute-forces a user code: the attempt budget burns the code", async () => {
    await h.ctx.settings.update({ security: { rateLimitEnabled: true } });
    const { body, client } = await startDevice();

    // The same code tried repeatedly trips the per-code budget (not just the per-IP one).
    let status = 0;
    for (let i = 0; i < DEVICE_ATTEMPT_BUDGET + 1; i++) {
      const res = await h.app.request(`/v1/client/oauth/device?user_code=${encodeURIComponent(body.user_code)}`, { headers: { cookie: session.cookie } });
      status = res.status;
    }
    expect(status).toBe(429);

    const row = first(await h.ctx.db.select().from(schema.deviceCodes).where(eq(schema.deviceCodes.userCode, body.user_code.replace("-", ""))))!;
    expect(row.status).toBe("denied");
    // The owner can no longer approve, and the device sees the denial.
    expect((await approve(body.user_code, session.cookie)).status).toBe(429);
    const deniedPoll = await poll(body.device_code, client);
    expect((await deniedPoll.json()).error).toBe("access_denied");
  });

  it("renders the verification page with an escaped, CSP-safe shell", async () => {
    const { body } = await startDevice();
    const page = await h.app.request(`/oauth/device?user_code=${encodeURIComponent(body.user_code)}`, { headers: { cookie: session.cookie } });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await page.text();
    expect(html).toContain("Test App");
    expect(html).toContain("openid");
    // The page is branded with the instance's application name.
    expect(html).toContain("OrbitID App");
    expect(html).not.toContain("<script>");
    expect(html).toContain('/oauth/device.js');

    const signedOut = await (await h.app.request("/oauth/device")).text();
    expect(signedOut).toContain("/sign-in");
    expect(signedOut).toContain("Sign in");
    expect(signedOut).not.toContain("Test App");
    // Signed out with a code: the page names the application and offers the way in.
    const signedOutWithCode = await (await h.app.request(`/oauth/device?user_code=${encodeURIComponent(body.user_code)}`)).text();
    expect(signedOutWithCode).toContain("Test App");
    expect(signedOutWithCode).toContain("/sign-in");
    // Signing in returns to this page with the code still filled in.
    expect(signedOutWithCode).toContain(`user_code%3D${encodeURIComponent(body.user_code)}`);

    const js = await h.app.request("/oauth/device.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(js.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await h.app.request("/oauth/device.css")).status).toBe(200);
  });

  it("approves and denies from the server-rendered page itself", async () => {
    const first = await startDevice();
    const approvePage = await h.app.request("/oauth/device", {
      method: "POST",
      headers: { cookie: session.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ user_code: first.body.user_code, action: "approve" }).toString(),
    });
    expect(approvePage.status).toBe(200);
    expect(await approvePage.text()).toContain("Device connected");

    const second = await startDevice();
    const denyPage = await h.app.request("/oauth/device", {
      method: "POST",
      headers: { cookie: session.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ user_code: second.body.user_code, action: "deny" }).toString(),
    });
    expect(denyPage.status).toBe(200);
    expect(await denyPage.text()).toContain("Request denied");
    expect((await (await poll(second.body.device_code, second.client)).json()).error).toBe("access_denied");

    // A signed-out POST changes nothing.
    const signedOut = await h.app.request("/oauth/device", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ user_code: first.body.user_code, action: "approve" }).toString(),
    });
    expect(signedOut.status).toBe(200);
    expect(await signedOut.text()).toContain("/sign-in");
  });

  it("refuses a cross-site approval form post", async () => {
    const { body } = await startDevice();
    const crossSite = await h.app.request("/oauth/device", {
      method: "POST",
      headers: { cookie: session.cookie, "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
      body: new URLSearchParams({ user_code: body.user_code, action: "approve" }).toString(),
    });
    expect(crossSite.status).toBe(403);
    expect(await crossSite.text()).toContain("blocked");

    const viaFetchMetadata = await h.app.request("/oauth/device", {
      method: "POST",
      headers: { cookie: session.cookie, "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "cross-site" },
      body: new URLSearchParams({ user_code: body.user_code, action: "approve" }).toString(),
    });
    expect(viaFetchMetadata.status).toBe(403);

    // Still pending: nothing was approved.
    const info = await h.app.request(`/v1/client/oauth/device?user_code=${encodeURIComponent(body.user_code)}`, { headers: { cookie: session.cookie } });
    expect((await info.json()).status).toBe("pending");
  });

  it("escapes the application name and the user code on the page", async () => {
    const evil = await createApp(h, { name: `<script>alert('x')</script>` }) as { client_id: string; client_secret: string };
    const res = await form(h, "/oauth/device_authorization", { client_id: evil.client_id, client_secret: evil.client_secret, scope: "openid" });
    const created = await res.json() as { user_code: string };
    const html = await (await h.app.request(`/oauth/device?user_code=${encodeURIComponent(created.user_code)}`, { headers: { cookie: session.cookie } })).text();
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");

    const injected = await (await h.app.request(`/oauth/device?user_code=${encodeURIComponent('"><script>alert(1)</script>')}`)).text();
    expect(injected).not.toContain("<script>alert(1)");
  });
});
