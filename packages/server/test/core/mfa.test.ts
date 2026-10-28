import { describe, expect, it } from "vitest";
import { authenticator } from "otplib";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { getSmsOutbox } from "../../src/services/mail";
import { endSessionsForUser } from "../../src/services/sessions";
import { errorsOf, setup, signInWithPassword, signUpUser, testClient, type TestClient } from "./helpers";

interface TotpSetup { response: { verified: boolean; secret: string; uri: string; qr_code: string; backup_codes?: { code: string }[] } }

async function enableTotp(client: TestClient) {
  const setupResponse = await client.json<TotpSetup>("/v1/client/me/totp", { body: {} });
  expect(setupResponse.response.uri).toMatch(/^otpauth:\/\/totp\//);
  expect(setupResponse.response.qr_code).toMatch(/^data:image\/png;base64,/);
  const code = authenticator.generate(setupResponse.response.secret);
  const verified = await client.json<TotpSetup>("/v1/client/me/totp/attempt_verification", { body: { code } });
  expect(verified.response.verified).toBe(true);
  expect(verified.response.backup_codes).toHaveLength(10);
  return { secret: setupResponse.response.secret, backupCodes: verified.response.backup_codes!.map((c) => c.code) };
}

describe("MFA", () => {
  it("gives a pending session until required MFA is enrolled", async () => {
    const { app, ctx } = await setup();
    await ctx.settings.update({ mfa: { required: true }, attributes: { authenticatorApp: { enabled: true } } });
    const user = await signUpUser(app);
    const statusOf = () => ctx.db.select().from(schema.sessions).where(eq(schema.sessions.id, user.sessionId)).get()?.status;
    expect(statusOf()).toBe("pending");

    const minted = await user.client.json<{ jwt: string }>(`/v1/client/sessions/${user.sessionId}/tokens`, { method: "POST", body: {} });
    expect(JSON.parse(Buffer.from(minted.jwt.split(".")[1]!, "base64url").toString()).sts).toBe("pending");

    await enableTotp(user.client);
    expect(statusOf()).toBe("active");
  });

  describe("pending sessions (required MFA, nothing enrolled yet)", () => {
    const statusOf = (ctx: Awaited<ReturnType<typeof setup>>["ctx"], id: string) =>
      ctx.db.select().from(schema.sessions).where(eq(schema.sessions.id, id)).get()?.status;
    const pendingSetup = async () => {
      const harness = await setup();
      await harness.ctx.settings.update({ mfa: { required: true }, attributes: { authenticatorApp: { enabled: true } } });
      return harness;
    };

    it("may enrol a factor but nothing else", async () => {
      const { app } = await pendingSetup();
      const user = await signUpUser(app);

      expect((await user.client.json<{ response: { id: string } }>("/v1/client/me")).response.id).toBe(user.userId);
      const blocked = await user.client.json("/v1/client/me", { method: "PATCH", body: { first_name: "Mallory" } });
      expect(errorsOf(blocked)[0]?.code).toBe("session_pending");
      const tokens = await user.client.json("/v1/client/me/external_accounts", { method: "POST", body: { strategy: "oauth_google" } });
      expect(errorsOf(tokens)[0]?.code).toBe("session_pending");
      expect((await user.client.json<TotpSetup>("/v1/client/me/totp", { body: {} })).response.uri).toMatch(/^otpauth:\/\//);
    });

    it("keeps sts pending even when custom session claims try to say otherwise", async () => {
      const { app, ctx } = await pendingSetup();
      await ctx.settings.update({ session: { customClaims: { sts: "active", org_role: "org:admin", plan: "pro" } } });
      const user = await signUpUser(app);

      const minted = await user.client.json<{ jwt: string }>(`/v1/client/sessions/${user.sessionId}/tokens`, { method: "POST", body: {} });
      const claims = JSON.parse(Buffer.from(minted.jwt.split(".")[1]!, "base64url").toString());
      expect(claims.sts).toBe("pending");
      expect(claims.org_role).toBeUndefined();
      expect(claims.plan).toBe("pro");
    });

    it("activates only the session that enrolled; other pending sessions are revoked", async () => {
      const { app, ctx } = await pendingSetup();
      const owner = await signUpUser(app);
      const other = await signInWithPassword(app, owner.email, owner.password);
      expect(statusOf(ctx, other.sessionId)).toBe("pending");

      await enableTotp(owner.client);
      expect(statusOf(ctx, owner.sessionId)).toBe("active");
      expect(statusOf(ctx, other.sessionId)).toBe("revoked");
    });

    it("is included when every session of a user is ended", async () => {
      const { app, ctx } = await pendingSetup();
      const user = await signUpUser(app);
      expect(statusOf(ctx, user.sessionId)).toBe("pending");
      await endSessionsForUser(ctx, user.userId, "revoked");
      expect(statusOf(ctx, user.sessionId)).toBe("revoked");
    });

    it("is activated by enrolling a verified phone as the second factor", async () => {
      const { app, ctx } = await pendingSetup();
      await ctx.settings.update({ attributes: { phoneNumber: { enabled: true, usedForSecondFactor: true } } });
      const user = await signUpUser(app);
      const now = Date.now();
      ctx.db.insert(schema.phoneNumbers).values({ id: "idn_p_test", userId: user.userId, phone: "+15551230000", verified: true, verifiedAt: now, createdAt: now, updatedAt: now }).run();

      await user.client.json("/v1/client/me/phone_numbers/idn_p_test", { method: "PATCH", body: { reserved_for_second_factor: true } });
      expect(statusOf(ctx, user.sessionId)).toBe("active");
    });
  });

  it("does not lock users out when no second factor can be enrolled", async () => {
    const { app, ctx } = await setup();
    await ctx.settings.update({ mfa: { required: true } });
    const user = await signUpUser(app);
    expect(ctx.db.select().from(schema.sessions).where(eq(schema.sessions.id, user.sessionId)).get()?.status).toBe("active");
  });

  it("enrolls TOTP, keeps the secret encrypted and requires it at sign-in", async () => {
    const { app, ctx } = await setup();
    const user = await signUpUser(app);
    const { secret } = await enableTotp(user.client);

    const stored = ctx.db.select().from(schema.users).where(eq(schema.users.id, user.userId)).get()!;
    expect(stored.totpVerified).toBe(true);
    expect(stored.totpSecretEnc).not.toContain(secret);
    expect(stored.totpSecretEnc).toMatch(/^v1\./);
    expect(stored.backupCodes?.length).toBe(10);

    const client = testClient(app);
    const created = await client.json<{ response: { id: string; status: string; supported_second_factors: { strategy: string }[] } }>("/v1/client/sign_ins", {
      body: { identifier: user.email, password: user.password },
    });
    expect(created.response.status).toBe("needs_second_factor");
    expect(created.response.supported_second_factors.map((f) => f.strategy)).toEqual(expect.arrayContaining(["totp", "backup_code"]));

    const bad = await client.json(`/v1/client/sign_ins/${created.response.id}/attempt_second_factor`, {
      body: { strategy: "totp", code: "000000" },
    });
    expect(errorsOf(bad)[0]?.code).toBe("form_code_incorrect");

    await client.json(`/v1/client/sign_ins/${created.response.id}/prepare_second_factor`, { body: { strategy: "totp" } });
    const done = await client.json<{ response: { status: string; created_session_id: string } }>(`/v1/client/sign_ins/${created.response.id}/attempt_second_factor`, {
      body: { strategy: "totp", code: authenticator.generate(secret) },
    });
    expect(done.response.status).toBe("complete");
    expect(done.response.created_session_id).toMatch(/^sess_/);
  });

  it("refuses a second factor before the first factor is verified", async () => {
    const { app } = await setup();
    const user = await signUpUser(app);
    const client = testClient(app);
    const created = await client.json<{ response: { id: string } }>("/v1/client/sign_ins", { body: { identifier: user.email } });
    const res = await client.json(`/v1/client/sign_ins/${created.response.id}/attempt_second_factor`, {
      body: { strategy: "totp", code: "123456" },
    });
    expect(errorsOf(res)[0]?.code).toBe("client_state_invalid");
  });

  it("uses a verified phone number as a second factor", async () => {
    const { app, ctx } = await setup();
    await ctx.settings.update({
      attributes: { phoneNumber: { enabled: true, usedForFirstFactor: true, usedForSecondFactor: true, verifications: ["phone_code"] } },
    });
    const user = await signUpUser(app);
    const phone = await user.client.json<{ response: { id: string } }>("/v1/client/me/phone_numbers", {
      body: { phone_number: "+15550001111" },
    });
    expect(phone.response.id).toMatch(/^idn_p_/);
    await user.client.json(`/v1/client/me/phone_numbers/${phone.response.id}/prepare_verification`, { body: {} });
    const setupCode = /(\d{6})/.exec(getSmsOutbox().at(-1)!.body)?.[1];
    await user.client.json(`/v1/client/me/phone_numbers/${phone.response.id}/attempt_verification`, { body: { code: setupCode } });
    await user.client.json(`/v1/client/me/phone_numbers/${phone.response.id}`, {
      method: "PATCH",
      body: { reserved_for_second_factor: true, default_second_factor: true },
    });

    const client = testClient(app);
    const created = await client.json<{ response: { id: string; status: string; supported_second_factors: { strategy: string }[] } }>("/v1/client/sign_ins", {
      body: { identifier: user.email, password: user.password },
    });
    expect(created.response.status).toBe("needs_second_factor");
    expect(created.response.supported_second_factors.some((f) => f.strategy === "phone_code")).toBe(true);
    await client.json(`/v1/client/sign_ins/${created.response.id}/prepare_second_factor`, { body: { strategy: "phone_code" } });
    const sms = getSmsOutbox().at(-1)!;
    expect(sms.to).toBe("+15550001111");
    const code = /(\d{6})/.exec(sms.body)?.[1];
    const done = await client.json<{ response: { status: string } }>(`/v1/client/sign_ins/${created.response.id}/attempt_second_factor`, {
      body: { strategy: "phone_code", code },
    });
    expect(done.response.status).toBe("complete");
  });

  it("signs in with a single-use backup code", async () => {
    const { app } = await setup();
    const user = await signUpUser(app);
    const { backupCodes } = await enableTotp(user.client);
    const code = backupCodes[0]!;

    const client = testClient(app);
    const created = await client.json<{ response: { id: string } }>("/v1/client/sign_ins", {
      body: { identifier: user.email, password: user.password },
    });
    await client.json(`/v1/client/sign_ins/${created.response.id}/prepare_second_factor`, { body: { strategy: "backup_code" } });
    const done = await client.json<{ response: { status: string } }>(`/v1/client/sign_ins/${created.response.id}/attempt_second_factor`, {
      body: { strategy: "backup_code", code },
    });
    expect(done.response.status).toBe("complete");

    // The same code cannot be reused.
    const other = testClient(app);
    const created2 = await other.json<{ response: { id: string } }>("/v1/client/sign_ins", {
      body: { identifier: user.email, password: user.password },
    });
    const reused = await other.json(`/v1/client/sign_ins/${created2.response.id}/attempt_second_factor`, {
      body: { strategy: "backup_code", code },
    });
    expect(errorsOf(reused)[0]?.code).toBe("form_code_incorrect");
  });

  it("regenerates backup codes and disables TOTP", async () => {
    const { app } = await setup();
    const user = await signUpUser(app);
    await enableTotp(user.client);

    const regenerated = await user.client.json<{ response: { code: string }[] }>("/v1/client/me/backup_codes", { body: {} });
    expect(regenerated.response).toHaveLength(10);

    const disabled = await user.client.json<{ response: { verified: boolean } }>("/v1/client/me/totp", { method: "DELETE" });
    expect(disabled.response.verified).toBe(false);

    const client = testClient(app);
    const plain = await client.json<{ response: { status: string; created_session_id: string } }>("/v1/client/sign_ins", {
      body: { identifier: user.email, password: user.password },
    });
    expect(plain.response.status).toBe("complete");
  });
});
