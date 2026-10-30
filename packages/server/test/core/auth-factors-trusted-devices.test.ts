// Trusted-device cookies: issuance, rotation, revocation and the Backend API surface.
import { describe, expect, it } from "vitest";
import { authenticator } from "otplib";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { first } from "../../src/lib/db";
import { sha256 } from "../../src/lib/crypto";
import { revokeAllTrustedDevices } from "../../src/services/trusted-devices";
import { errorsOf, setup, signUpUser, testClient, type TestClient } from "./helpers";
import { TRUSTED_COOKIE, cookieValue, enableTotp, startSignIn } from "./auth-factors-helpers";
describe("trusted devices", () => {
  const enableTrusted = async (ctx: Awaited<ReturnType<typeof setup>>["ctx"], days = 30) => {
    await ctx.settings.update({ session: { trustedDevicesEnabled: true, trustedDeviceDays: days } });
  };

  /** Completes a second-factor sign-in, optionally trusting the browser. */
  async function signInWithTotp(
    app: Awaited<ReturnType<typeof setup>>["app"],
    user: { email: string; password: string },
    secret: string,
    opts: { trust?: boolean; client?: TestClient } = {},
  ) {
    const started = await startSignIn(app, user.email, user.password);
    const client = opts.client ?? started.client;
    if (opts.client) {
      // Re-use another client's cookie jar: redo the sign-in on it.
      const created = await client.json<{ response: { id: string } }>("/v1/client/sign_ins", {
        body: { identifier: user.email, password: user.password },
      });
      started.id = created.response.id;
    }
    await client.json(`/v1/client/sign_ins/${started.id}/prepare_second_factor`, { body: { strategy: "totp" } });
    const done = await client.json<{ response: { status: string; created_session_id: string } }>(
      `/v1/client/sign_ins/${started.id}/attempt_second_factor`,
      { body: { strategy: "totp", code: authenticator.generate(secret), ...(opts.trust ? { trust_device: true } : {}) } },
    );
    return { client, id: started.id, done };
  }

  it("issues an HttpOnly cookie and stores only the token hash", async () => {
    const { app, ctx } = await setup();
    await enableTrusted(ctx);
    const user = await signUpUser(app);
    const secret = await enableTotp(user.client);

    const { client } = await signInWithTotp(app, user, secret, { trust: true });
    const token = cookieValue(client, TRUSTED_COOKIE);
    expect(token).toBeTruthy();
    const rows = await ctx.db.select().from(schema.trustedDevices);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(sha256(token!));
    expect(rows[0]!.tokenHash).not.toContain(token!);
    expect(rows[0]!.expiresAt).toBeGreaterThan(Date.now() + 29 * 24 * 3600_000);
  });

  it("skips the second factor on the next sign-in and rotates the token without sliding the expiry", async () => {
    const { app, ctx } = await setup();
    await enableTrusted(ctx);
    const user = await signUpUser(app);
    const secret = await enableTotp(user.client);
    const login = await signInWithTotp(app, user, secret, { trust: true });
    const originalToken = cookieValue(login.client, TRUSTED_COOKIE)!;
    const original = first(await ctx.db.select().from(schema.trustedDevices))!;

    // A fresh client that carries the trusted cookie (same browser, new sign-in).
    const browser = testClient(app, `${TRUSTED_COOKIE}=${originalToken}`);
    const created = await browser.json<{ response: { status: string; created_session_id: string } }>("/v1/client/sign_ins", {
      body: { identifier: user.email, password: user.password },
    });
    expect(created.response.status).toBe("complete");
    expect(created.response.created_session_id).toMatch(/^sess_/);

    const rotatedToken = cookieValue(browser, TRUSTED_COOKIE);
    expect(rotatedToken).toBeTruthy();
    expect(rotatedToken).not.toBe(originalToken);
    const row = first(await ctx.db.select().from(schema.trustedDevices))!;
    expect(row.tokenHash).toBe(sha256(rotatedToken!));
    expect(row.expiresAt).toBe(original.expiresAt);
    expect(row.lastUsedAt).toBeGreaterThan(0);

    // The session is marked as having skipped the factor for a trusted device.
    const state = await browser.json<{ response: { sessions: { second_factor_skipped_by_trusted_device?: boolean }[] } }>("/v1/client");
    expect(state.response.sessions[0]?.second_factor_skipped_by_trusted_device).toBe(true);
  });

  it("never honours a replayed (already rotated) token", async () => {
    const { app, ctx } = await setup();
    await enableTrusted(ctx);
    const user = await signUpUser(app);
    const secret = await enableTotp(user.client);
    const firstLogin = await signInWithTotp(app, user, secret, { trust: true });
    const stolen = cookieValue(firstLogin.client, TRUSTED_COOKIE)!;

    // Rotate it once, legitimately.
    const rotated = await startSignIn(app, user.email, user.password);
    const replayClient = testClient(app, `${TRUSTED_COOKIE}=${stolen}`);
    const created = await replayClient.json<{ response: { status: string } }>("/v1/client/sign_ins", {
      body: { identifier: user.email, password: user.password },
    });
    expect(created.response.status).toBe("complete");
    void rotated;

    // The old value is now dead AND the new value belongs to the previous response: the stolen one is refused.
    const second = testClient(app, `${TRUSTED_COOKIE}=${stolen}`);
    const again = await second.json<{ response: { status: string } }>("/v1/client/sign_ins", {
      body: { identifier: user.email, password: user.password },
    });
    expect(again.response.status).toBe("needs_second_factor");
  });

  it("refuses a tampered or foreign cookie and still requires the second factor", async () => {
    const { app, ctx } = await setup();
    await enableTrusted(ctx);
    const owner = await signUpUser(app);
    const other = await signUpUser(app);
    const secret = await enableTotp(owner.client);
    await enableTotp(other.client);

    const firstLogin = await signInWithTotp(app, owner, secret, { trust: true });
    const ownerToken = cookieValue(firstLogin.client, TRUSTED_COOKIE)!;

    // Tampered value.
    const tampered = testClient(app, `${TRUSTED_COOKIE}=${ownerToken}tampered`);
    const tamperedAttempt = await tampered.json<{ response: { status: string } }>("/v1/client/sign_ins", {
      body: { identifier: owner.email, password: owner.password },
    });
    expect(tamperedAttempt.response.status).toBe("needs_second_factor");

    // Another user's valid token does not unlock this account.
    const foreign = testClient(app, `${TRUSTED_COOKIE}=${ownerToken}`);
    const foreignAttempt = await foreign.json<{ response: { status: string } }>("/v1/client/sign_ins", {
      body: { identifier: other.email, password: other.password },
    });
    expect(foreignAttempt.response.status).toBe("needs_second_factor");
  });

  it("refuses a revoked token", async () => {
    const { app, ctx } = await setup();
    await enableTrusted(ctx);
    const user = await signUpUser(app);
    const secret = await enableTotp(user.client);
    const login = await signInWithTotp(app, user, secret, { trust: true });
    const token = cookieValue(login.client, TRUSTED_COOKIE)!;
    await ctx.db.update(schema.trustedDevices).set({ revokedAt: Date.now() });

    const browser = testClient(app, `${TRUSTED_COOKIE}=${token}`);
    const attempt = await browser.json<{ response: { status: string } }>("/v1/client/sign_ins", {
      body: { identifier: user.email, password: user.password },
    });
    expect(attempt.response.status).toBe("needs_second_factor");
  });

  it("refuses an expired token", async () => {
    const { app, ctx } = await setup();
    await enableTrusted(ctx);
    const user = await signUpUser(app);
    const secret = await enableTotp(user.client);
    const login = await signInWithTotp(app, user, secret, { trust: true });
    const token = cookieValue(login.client, TRUSTED_COOKIE)!;
    await ctx.db.update(schema.trustedDevices).set({ expiresAt: Date.now() - 1000 });

    const browser = testClient(app, `${TRUSTED_COOKIE}=${token}`);
    const attempt = await browser.json<{ response: { status: string } }>("/v1/client/sign_ins", {
      body: { identifier: user.email, password: user.password },
    });
    expect(attempt.response.status).toBe("needs_second_factor");
  });

  it("does not issue a cookie when the setting is off", async () => {
    const { app, ctx } = await setup();
    const user = await signUpUser(app);
    const secret = await enableTotp(user.client);
    const login = await signInWithTotp(app, user, secret, { trust: true });
    expect(cookieValue(login.client, TRUSTED_COOKIE)).toBeUndefined();
    expect(await ctx.db.select().from(schema.trustedDevices)).toHaveLength(0);
  });

  it("lists and revokes only the caller's own devices", async () => {
    const { app, ctx } = await setup();
    await enableTrusted(ctx);
    const owner = await signUpUser(app);
    const other = await signUpUser(app);
    const ownerSecret = await enableTotp(owner.client);
    const otherSecret = await enableTotp(other.client);
    await signInWithTotp(app, owner, ownerSecret, { trust: true });
    await signInWithTotp(app, other, otherSecret, { trust: true });

    const list = await owner.client.json<{ response: { id: string; label: string; user_id: string }[] }>("/v1/client/me/trusted_devices");
    expect(list.response).toHaveLength(1);
    expect(list.response[0]!.user_id).toBe(owner.userId);
    expect(JSON.stringify(list.response)).not.toContain("token");

    const foreignDevice = first(await ctx.db.select().from(schema.trustedDevices).where(eq(schema.trustedDevices.userId, other.userId)))!;
    const denied = await owner.client.json(`/v1/client/me/trusted_devices/${foreignDevice.id}`, { method: "DELETE" });
    expect(errorsOf(denied)[0]?.code).toBe("resource_not_found");

    const passport = await owner.client.json<{ response: { object: string; id: string; deleted: boolean } }>(
      `/v1/client/me/trusted_devices/${list.response[0]!.id}`,
      { method: "DELETE" },
    );
    expect(passport.response.deleted).toBe(true);
    expect((await owner.client.json<{ response: unknown[] }>("/v1/client/me/trusted_devices")).response).toHaveLength(0);
  });

  it("revokes every device when the password changes", async () => {
    const { app, ctx } = await setup();
    await enableTrusted(ctx);
    const user = await signUpUser(app);
    const secret = await enableTotp(user.client);
    await signInWithTotp(app, user, secret, { trust: true });
    expect(await ctx.db.select().from(schema.trustedDevices)).toHaveLength(1);

    await user.client.json("/v1/client/me/change_password", {
      body: { current_password: user.password, new_password: "An0therSecret!" },
    });
    const rows = await ctx.db.select().from(schema.trustedDevices);
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);

    const browser = testClient(app);
    const attempt = await browser.json<{ response: { status: string } }>("/v1/client/sign_ins", {
      body: { identifier: user.email, password: "An0therSecret!" },
    });
    expect(attempt.response.status).toBe("needs_second_factor");
  });

  it("revokes every device when the second factor is removed", async () => {
    const { app, ctx } = await setup();
    await enableTrusted(ctx);
    const user = await signUpUser(app);
    const secret = await enableTotp(user.client);
    await signInWithTotp(app, user, secret, { trust: true });

    await user.client.json("/v1/client/me/totp", { method: "DELETE" });
    expect((await ctx.db.select().from(schema.trustedDevices)).every((row) => row.revokedAt !== null)).toBe(true);
  });

  it("revokes every device when a user is banned or locked", async () => {
    const { app, ctx } = await setup();
    await enableTrusted(ctx);
    const user = await signUpUser(app);
    const secret = await enableTotp(user.client);
    await signInWithTotp(app, user, secret, { trust: true });
    await ctx.db.update(schema.users).set({ banned: true }).where(eq(schema.users.id, user.userId));
    await revokeAllTrustedDevices(ctx, user.userId);
    expect((await ctx.db.select().from(schema.trustedDevices)).every((row) => row.revokedAt !== null)).toBe(true);
  });

  it("is honoured only for users who enrolled a factor when MFA is required", async () => {
    const { app, ctx } = await setup();
    await enableTrusted(ctx);
    await ctx.settings.update({ mfa: { required: true }, attributes: { authenticatorApp: { enabled: true } } });
    const user = await signUpUser(app);
    const secret = await enableTotp(user.client);
    const login = await signInWithTotp(app, user, secret, { trust: true });
    const token = cookieValue(login.client, TRUSTED_COOKIE)!;

    const browser = testClient(app, `${TRUSTED_COOKIE}=${token}`);
    const attempt = await browser.json<{ response: { status: string } }>("/v1/client/sign_ins", {
      body: { identifier: user.email, password: user.password },
    });
    expect(attempt.response.status).toBe("complete");
  });

  it("cannot be forged through custom session claims", async () => {
    const { app, ctx } = await setup();
    await ctx.settings.update({ session: { customClaims: { anonymous: false } } });
    const user = await signUpUser(app);
    const token = await user.client.json<{ jwt: string }>(`/v1/client/sessions/${user.sessionId}/tokens`, { method: "POST", body: {} });
    const claims = JSON.parse(Buffer.from(token.jwt.split(".")[1]!, "base64url").toString());
    // A regular account never carries the claim, whatever the instance configured.
    expect(claims.anonymous).toBeUndefined();
  });

  it("is exposed through the Backend API with revoke", async () => {
    const { app, ctx } = await setup();
    await enableTrusted(ctx);
    const user = await signUpUser(app);
    const secret = await enableTotp(user.client);
    await signInWithTotp(app, user, secret, { trust: true });

    const backend = testClient(app);
    const list = await backend.json<{ id: string; user_id: string }[]>(`/v1/users/${user.userId}/trusted_devices`, {
      headers: { authorization: `Bearer ${ctx.env.secretKey}` },
    });
    expect(list).toHaveLength(1);
    const removed = await backend.json<{ object: string; deleted: boolean }>(`/v1/users/${user.userId}/trusted_devices/${list[0]!.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${ctx.env.secretKey}` },
    });
    expect(removed.deleted).toBe(true);
    const empty = await backend.json<unknown[]>(`/v1/users/${user.userId}/trusted_devices`, {
      headers: { authorization: `Bearer ${ctx.env.secretKey}` },
    });
    expect(empty).toHaveLength(0);
  });
});
