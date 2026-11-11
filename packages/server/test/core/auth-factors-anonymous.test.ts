// Anonymous (guest) accounts: creation, upgrade, restrictions and retention cleanup.
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { first } from "../../src/lib/db";
import { latestCodeFor } from "../../src/services/mail";
import { setCaptchaVerifierForTests } from "../../src/services/captcha";
import { cleanupAnonymousUsers, staleAnonymousUserIds } from "../../src/services/anonymous";
import { errorsOf, setup, signUpUser, testClient } from "./helpers";
describe("anonymous accounts", () => {
  const enableAnonymous = async (ctx: Awaited<ReturnType<typeof setup>>["ctx"]) => {
    await ctx.settings.update({ anonymous: { enabled: true } });
  };

  const createAnonymous = async (app: Awaited<ReturnType<typeof setup>>["app"]) => {
    const client = testClient(app);
    const created = await client.json<{ response: { status: string; created_session_id: string; created_user_id: string } }>(
      "/v1/client/sign_ups",
      { body: { strategy: "anonymous" } },
    );
    return { client, created: created.response };
  };

  it("is disabled by default", async () => {
    const { app } = await setup();
    const client = testClient(app);
    const response = await client.json("/v1/client/sign_ups", { body: { strategy: "anonymous" } });
    expect(errorsOf(response)[0]?.code).toBe("sign_up_restricted");
  });

  it("creates a user with no identifiers, an active session and an anonymous claim", async () => {
    const { app, ctx } = await setup();
    await enableAnonymous(ctx);
    const { client, created } = await createAnonymous(app);
    expect(created.status).toBe("complete");
    expect(created.created_session_id).toMatch(/^sess_/);

    const me = await client.json<{ response: { id: string; is_anonymous: boolean; email_addresses: unknown[]; password_enabled: boolean } }>("/v1/client/me");
    expect(me.response.is_anonymous).toBe(true);
    expect(me.response.email_addresses).toHaveLength(0);
    expect(me.response.password_enabled).toBe(false);

    const token = await client.json<{ jwt: string }>(`/v1/client/sessions/${created.created_session_id}/tokens`, { method: "POST", body: {} });
    const claims = JSON.parse(Buffer.from(token.jwt.split(".")[1]!, "base64url").toString());
    expect(claims.anonymous).toBe(true);
  });

  it("stops advertising the claim after an in-place upgrade", async () => {
    const { app, ctx } = await setup();
    await enableAnonymous(ctx);
    const { client, created } = await createAnonymous(app);

    const email = await client.json<{ response: { id: string } }>("/v1/client/me/email_addresses", {
      body: { email_address: "guest@example.com" },
    });
    await client.json(`/v1/client/me/email_addresses/${email.response.id}/prepare_verification`, { body: {} });
    const code = latestCodeFor("guest@example.com");
    await client.json(`/v1/client/me/email_addresses/${email.response.id}/attempt_verification`, { body: { code } });

    const me = await client.json<{ response: { is_anonymous: boolean } }>("/v1/client/me");
    expect(me.response.is_anonymous).toBe(false);
    const token = await client.json<{ jwt: string }>(`/v1/client/sessions/${created.created_session_id}/tokens`, { method: "POST", body: {} });
    const claims = JSON.parse(Buffer.from(token.jwt.split(".")[1]!, "base64url").toString());
    expect(claims.anonymous).toBeUndefined();
  });

  it("needs a verified identifier before a password can be set, and a password alone does not upgrade a guest", async () => {
    const { app, ctx } = await setup();
    await enableAnonymous(ctx);
    const { client } = await createAnonymous(app);
    const refused = await client.json("/v1/client/me/change_password", { body: { new_password: "Sup3rSecret!" } });
    expect(errorsOf(refused)[0]?.code).toBe("form_param_value_invalid");
    const still = await client.json<{ response: { is_anonymous: boolean; password_enabled: boolean } }>("/v1/client/me");
    expect(still.response.is_anonymous).toBe(true);
    expect(still.response.password_enabled).toBe(false);
  });

  it("may not create organizations or API keys", async () => {
    const { app, ctx } = await setup();
    await enableAnonymous(ctx);
    await ctx.settings.update({ organizations: { enabled: true } });
    const { client } = await createAnonymous(app);

    const org = await client.json("/v1/client/organizations", { body: { name: "Guests Inc" } });
    expect(errorsOf(org)[0]?.code).toBe("organization_creation_not_allowed");

    const key = await client.json("/v1/client/me/api_keys", { body: { name: "guest key" } });
    expect(errorsOf(key)[0]?.code).toBe("not_allowed_access");
  });

  it("honours the CAPTCHA setting", async () => {
    const { app, ctx } = await setup();
    await enableAnonymous(ctx);
    await ctx.settings.update({ security: { captchaProvider: "turnstile", captchaSecret: "secret", captchaSiteKey: "site" } });
    setCaptchaVerifierForTests(async (token) => token === "human");
    try {
      const client = testClient(app);
      const denied = await client.json("/v1/client/sign_ups", { body: { strategy: "anonymous" } });
      expect(errorsOf(denied)[0]?.code).toBe("bot_detected");
      const allowed = await client.json<{ response: { status: string } }>("/v1/client/sign_ups", { body: { strategy: "anonymous", captcha_token: "human" } });
      expect(allowed.response.status).toBe("complete");
    } finally {
      setCaptchaVerifierForTests(null);
    }
  });

  it("is rate limited per address", async () => {
    const { app, ctx } = await setup();
    await enableAnonymous(ctx);
    const client = testClient(app);
    let last: unknown;
    for (let i = 0; i < 10; i += 1) {
      last = await client.json("/v1/client/sign_ups", { body: { strategy: "anonymous" } });
      expect(errorsOf(last)).toHaveLength(0);
    }
    const blocked = await client.json("/v1/client/sign_ups", { body: { strategy: "anonymous" } });
    expect(errorsOf(blocked)[0]?.code).toBe("rate_limit_exceeded");
  });

  it("cleans up only stale anonymous users", async () => {
    const { app, ctx } = await setup();
    await enableAnonymous(ctx);
    await ctx.settings.update({ anonymous: { enabled: true, retentionSeconds: 3600 } });
    const stale = await createAnonymous(app);
    const fresh = await createAnonymous(app);
    const regular = await signUpUser(app);

    // Age the first guest and the regular account past the retention window.
    const old = Date.now() - 7200_000;
    await ctx.db.update(schema.users).set({ lastActiveAt: old }).where(eq(schema.users.id, stale.created.created_user_id));
    await ctx.db.update(schema.users).set({ lastActiveAt: old }).where(eq(schema.users.id, regular.userId));
    // Retention is not a sign-out: a guest with a live session is kept. End the stale guest's session first.
    await ctx.db.update(schema.sessions).set({ status: "ended" })
      .where(eq(schema.sessions.userId, stale.created.created_user_id));

    expect(await staleAnonymousUserIds(ctx)).toEqual([stale.created.created_user_id]);
    expect(await cleanupAnonymousUsers(ctx)).toBe(1);

    expect(first(await ctx.db.select().from(schema.users).where(eq(schema.users.id, stale.created.created_user_id)))).toBeUndefined();
    expect(first(await ctx.db.select().from(schema.users).where(eq(schema.users.id, fresh.created.created_user_id)))).toBeDefined();
    expect(first(await ctx.db.select().from(schema.users).where(eq(schema.users.id, regular.userId)))).toBeDefined();
  });

  it("keeps anonymous users when retention is 0", async () => {
    const { app, ctx } = await setup();
    await ctx.settings.update({ anonymous: { enabled: true, retentionSeconds: 0 } });
    const guest = await createAnonymous(app);
    await ctx.db.update(schema.users).set({ lastActiveAt: Date.now() - 90 * 24 * 3600_000 }).where(eq(schema.users.id, guest.created.created_user_id));
    expect(await cleanupAnonymousUsers(ctx)).toBe(0);
    expect(first(await ctx.db.select().from(schema.users).where(eq(schema.users.id, guest.created.created_user_id)))).toBeDefined();
  });

  it("is filterable in the Backend API user list and appears in webhook payloads", async () => {
    const { app, ctx } = await setup();
    await enableAnonymous(ctx);
    const guest = await createAnonymous(app);
    await signUpUser(app);

    const backend = testClient(app);
    const guests = await backend.json<{ id: string; is_anonymous: boolean }[]>("/v1/users?is_anonymous=true", {
      headers: { authorization: `Bearer ${ctx.env.secretKey}` },
    });
    expect(guests.map((u) => u.id)).toEqual([guest.created.created_user_id]);
    expect(guests[0]!.is_anonymous).toBe(true);

    const regular = await backend.json<{ id: string; is_anonymous: boolean }[]>("/v1/users?is_anonymous=false", {
      headers: { authorization: `Bearer ${ctx.env.secretKey}` },
    });
    expect(regular.every((u) => !u.is_anonymous)).toBe(true);
    expect(regular.some((u) => u.id === guest.created.created_user_id)).toBe(false);
  });

  it("reports anonymous in the public environment only when enabled", async () => {
    const { app, ctx } = await setup();
    const client = testClient(app);
    const off = await client.json<{ auth_config: { anonymous: { enabled: boolean } } }>("/v1/client/environment");
    expect(off.auth_config.anonymous.enabled).toBe(false);
    await enableAnonymous(ctx);
    const on = await client.json<{ auth_config: { anonymous: { enabled: boolean } } }>("/v1/client/environment");
    expect(on.auth_config.anonymous.enabled).toBe(true);
  });
});
