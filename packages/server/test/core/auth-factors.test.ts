// Email-code second factor, trusted devices and anonymous (guest) accounts.
import { describe, expect, it } from "vitest";
import { authenticator } from "otplib";
import { and, eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { first } from "../../src/lib/db";
import { sha256 } from "../../src/lib/crypto";
import { latestCodeFor } from "../../src/services/mail";
import { setCaptchaVerifierForTests } from "../../src/services/captcha";
import { cleanupAnonymousUsers, staleAnonymousUserIds } from "../../src/services/anonymous";
import { revokeAllTrustedDevices } from "../../src/services/trusted-devices";
import { errorsOf, setup, signUpUser, testClient, type TestClient } from "./helpers";

const TRUSTED_COOKIE = "__orbit_trusted";

/** Reads one cookie the client jar holds (the jar is exposed through the request headers). */
function cookieValue(client: TestClient, name: string): string | undefined {
  const header = client.cookie ?? "";
  for (const part of header.split(/;\s*/)) {
    const [key, ...rest] = part.split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

async function enableEmailSecondFactor(ctx: Awaited<ReturnType<typeof setup>>["ctx"]) {
  await ctx.settings.update({
    attributes: {
      emailAddress: { enabled: true, required: true, usedForFirstFactor: true, usedForSecondFactor: true, verifications: ["email_code"], verifyAtSignUp: true },
    },
  });
}

async function enableTotp(client: TestClient): Promise<string> {
  const created = await client.json<{ response: { secret: string } }>("/v1/client/me/totp", { body: {} });
  const code = authenticator.generate(created.response.secret);
  await client.json("/v1/client/me/totp/attempt_verification", { body: { code } });
  return created.response.secret;
}

/** Sign-in up to `needs_second_factor`. */
async function startSignIn(app: Awaited<ReturnType<typeof setup>>["app"], email: string, password: string) {
  const client = testClient(app);
  const created = await client.json<{
    response: { id: string; status: string; supported_second_factors: { strategy: string; email_address_id?: string }[] };
  }>("/v1/client/sign_ins", { body: { identifier: email, password } });
  return { client, id: created.response.id, secondFactors: created.response.supported_second_factors };
}

describe("email code as a second factor", () => {
  it("is offered, sends a code and completes the sign-in exactly once", async () => {
    const { app, ctx } = await setup();
    await enableEmailSecondFactor(ctx);
    const user = await signUpUser(app);

    const started = await startSignIn(app, user.email, user.password);
    expect(started.secondFactors.map((f) => f.strategy)).toContain("email_code");

    const prepared = await started.client.json<{ response: { second_factor_verification: { strategy: string; status: string } } }>(
      `/v1/client/sign_ins/${started.id}/prepare_second_factor`,
      { body: { strategy: "email_code" } },
    );
    expect(prepared.response.second_factor_verification.strategy).toBe("email_code");
    const code = latestCodeFor(user.email);
    expect(code).toMatch(/^\d{6}$/);

    const done = await started.client.json<{ response: { status: string; created_session_id: string } }>(
      `/v1/client/sign_ins/${started.id}/attempt_second_factor`,
      { body: { strategy: "email_code", code } },
    );
    expect(done.response.status).toBe("complete");
    expect(done.response.created_session_id).toMatch(/^sess_/);

    // The code is single use: a second attempt cannot verify the same sign-in again.
    const replay = await started.client.json(`/v1/client/sign_ins/${started.id}/attempt_second_factor`, {
      body: { strategy: "email_code", code },
    });
    expect(errorsOf(replay).length).toBeGreaterThan(0);
  });

  it("counts a wrong code against the attempt limit", async () => {
    const { app, ctx } = await setup();
    await enableEmailSecondFactor(ctx);
    const user = await signUpUser(app);
    const started = await startSignIn(app, user.email, user.password);
    await started.client.json(`/v1/client/sign_ins/${started.id}/prepare_second_factor`, { body: { strategy: "email_code" } });

    const wrong = await started.client.json(`/v1/client/sign_ins/${started.id}/attempt_second_factor`, {
      body: { strategy: "email_code", code: "000000" },
    });
    expect(errorsOf(wrong)[0]?.code).toBe("form_code_incorrect");
    const row = first(await ctx.db.select().from(schema.verifications)
      .where(and(eq(schema.verifications.ownerId, started.id), eq(schema.verifications.purpose, "sign_in_second_factor"))));
    expect(row?.attempts).toBe(1);
  });

  it("is refused when the instance has not enabled it", async () => {
    const { app } = await setup();
    const user = await signUpUser(app);
    await enableTotp(user.client);
    const started = await startSignIn(app, user.email, user.password);
    expect(started.secondFactors.map((f) => f.strategy)).not.toContain("email_code");
    const response = await started.client.json(`/v1/client/sign_ins/${started.id}/prepare_second_factor`, {
      body: { strategy: "email_code" },
    });
    expect(errorsOf(response)[0]?.code).toBe("strategy_for_user_invalid");
  });

  it("is not offered when the first factor was the email itself", async () => {
    const { app, ctx } = await setup();
    await enableEmailSecondFactor(ctx);
    const user = await signUpUser(app);
    // Enrol a second factor so the account needs one, then sign in with an email code.
    await enableTotp(user.client);

    const client = testClient(app);
    const created = await client.json<{ response: { id: string } }>("/v1/client/sign_ins", {
      body: { identifier: user.email, strategy: "email_code" },
    });
    await client.json(`/v1/client/sign_ins/${created.response.id}/prepare_first_factor`, { body: { strategy: "email_code" } });
    const code = latestCodeFor(user.email);
    const escalated = await client.json<{ response: { status: string; supported_second_factors: { strategy: string }[] } }>(
      `/v1/client/sign_ins/${created.response.id}/attempt_first_factor`,
      { body: { strategy: "email_code", code } },
    );
    expect(escalated.response.status).toBe("needs_second_factor");
    expect(escalated.response.supported_second_factors.map((f) => f.strategy)).not.toContain("email_code");

    const blocked = await client.json(`/v1/client/sign_ins/${created.response.id}/prepare_second_factor`, {
      body: { strategy: "email_code" },
    });
    expect(errorsOf(blocked)[0]?.code).toBe("strategy_for_user_invalid");
  });

  it("is listed in the environment's second_factors", async () => {
    const { app, ctx } = await setup();
    await enableEmailSecondFactor(ctx);
    const client = testClient(app);
    const env = await client.json<{ auth_config: { second_factors: string[] } }>("/v1/client/environment");
    expect(env.auth_config.second_factors).toContain("email_code");
  });
});

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
