import { describe, expect, it } from "vitest";
import * as schema from "../../src/db/schema";
import { getSmsOutbox, latestCodeFor } from "../../src/services/mail";
import { errorsOf, getClient, setup, signUpUser, testClient } from "./helpers";

type Context = Awaited<ReturnType<typeof setup>>["ctx"];

async function addVerifiedPhone(ctx: Context, userId: string, phone: string, reservedForSecondFactor = false) {
  const now = Date.now();
  const id = `idn_p_${Math.random().toString(36).slice(2, 10)}`;
  await ctx.db.insert(schema.phoneNumbers).values({
    id, userId, phone, verified: true, verifiedAt: now, reservedForSecondFactor, createdAt: now, updatedAt: now,
  });
  return id;
}

describe("MFA recovery", () => {
  it("rejects a recovery code presented with the other recovery strategy", async () => {
    const { app, ctx } = await setup();
    await ctx.settings.update({
      attributes: {
        emailAddress: { enabled: true, usedForFirstFactor: true, usedForSecondFactor: true, verifications: ["email_code"], verifyAtSignUp: true },
        phoneNumber: { enabled: true, usedForFirstFactor: true, usedForSecondFactor: true, verifications: ["phone_code"] },
      },
    });
    const user = await signUpUser(app, { email: "recovery-email@example.com" });
    await addVerifiedPhone(ctx, user.userId, "+15550004444", true);

    const client = testClient(app);
    const created = await client.json<{ response: { id: string } }>("/v1/client/sign_ins", {
      body: { identifier: user.email, strategy: "reset_password_email_code" },
    });
    await client.json(`/v1/client/sign_ins/${created.response.id}/prepare_first_factor`, {
      body: { strategy: "reset_password_email_code" },
    });
    const code = latestCodeFor(user.email, "reset_password_code")!;

    const spoofed = await client.json(`/v1/client/sign_ins/${created.response.id}/attempt_first_factor`, {
      body: { strategy: "reset_password_phone_code", code },
    });
    expect(errorsOf(spoofed)[0]?.code).toBe("client_state_invalid");

    const pending = await client.json<{ response: { status: string; first_factor_verification: { strategy: string; status: string } | null } }>(
      `/v1/client/sign_ins/${created.response.id}`,
    );
    expect(pending.response.status).toBe("needs_first_factor");
    expect(pending.response.first_factor_verification?.strategy).toBe("reset_password_email_code");
    expect(pending.response.first_factor_verification?.status).toBe("unverified");

    // The correct strategy still works with the same code, and the recovered mailbox stays out of the second factor.
    const verified = await client.json<{ response: { status: string; first_factor_verification: { strategy: string; status: string } | null } }>(
      `/v1/client/sign_ins/${created.response.id}/attempt_first_factor`,
      { body: { strategy: "reset_password_email_code", code } },
    );
    expect(verified.response.status).toBe("needs_new_password");
    expect(verified.response.first_factor_verification?.strategy).toBe("reset_password_email_code");
    const reset = await client.json<{ response: { status: string; supported_second_factors: { strategy: string }[] } }>(
      `/v1/client/sign_ins/${created.response.id}/reset_password`,
      { body: { password: "N3wSup3rSecret!", sign_out_of_other_sessions: false } },
    );
    expect(reset.response.status).toBe("needs_second_factor");
    expect(reset.response.supported_second_factors.map((f) => f.strategy)).not.toContain("email_code");
    expect(reset.response.supported_second_factors.map((f) => f.strategy)).toContain("phone_code");
  });

  it("rejects an email strategy when phone recovery was prepared", async () => {
    const { app, ctx } = await setup();
    await ctx.settings.update({
      attributes: {
        emailAddress: { enabled: true, usedForFirstFactor: true, usedForSecondFactor: true, verifications: ["email_code"], verifyAtSignUp: true },
        phoneNumber: { enabled: true, usedForFirstFactor: true, usedForSecondFactor: true, verifications: ["phone_code"] },
      },
    });
    const user = await signUpUser(app, { email: "recovery-phone@example.com" });
    const phone = "+15550005555";
    const phoneId = await addVerifiedPhone(ctx, user.userId, phone, true);

    const client = testClient(app);
    const created = await client.json<{ response: { id: string } }>("/v1/client/sign_ins", {
      body: { identifier: phone, strategy: "reset_password_phone_code" },
    });
    await client.json(`/v1/client/sign_ins/${created.response.id}/prepare_first_factor`, {
      body: { strategy: "reset_password_phone_code", phone_number_id: phoneId },
    });
    const code = /(\d{6})/.exec(getSmsOutbox().at(-1)!.body)?.[1]!;

    const spoofed = await client.json(`/v1/client/sign_ins/${created.response.id}/attempt_first_factor`, {
      body: { strategy: "reset_password_email_code", code },
    });
    expect(errorsOf(spoofed)[0]?.code).toBe("client_state_invalid");

    const verified = await client.json<{ response: { status: string; first_factor_verification: { strategy: string } | null } }>(
      `/v1/client/sign_ins/${created.response.id}/attempt_first_factor`,
      { body: { strategy: "reset_password_phone_code", code } },
    );
    expect(verified.response.status).toBe("needs_new_password");
    expect(verified.response.first_factor_verification?.strategy).toBe("reset_password_phone_code");

    const reset = await client.json<{ response: { status: string; supported_second_factors: { strategy: string }[] } }>(
      `/v1/client/sign_ins/${created.response.id}/reset_password`,
      { body: { password: "N3wSup3rSecret!", sign_out_of_other_sessions: false } },
    );
    // The recovered handset is excluded, and the spoof did not relabel it as an email first factor.
    expect(reset.response.status).toBe("needs_second_factor");
    expect(reset.response.supported_second_factors.map((f) => f.strategy)).not.toContain("phone_code");
    expect(reset.response.supported_second_factors.map((f) => f.strategy)).toContain("email_code");
  });

  it("rejects a first-factor attempt that names a different strategy than prepared", async () => {
    const { app, ctx } = await setup();
    await ctx.settings.update({
      attributes: {
        emailAddress: { enabled: true, usedForFirstFactor: true, verifications: ["email_code"], verifyAtSignUp: true },
        phoneNumber: { enabled: true, usedForFirstFactor: true, verifications: ["phone_code"] },
      },
    });
    const user = await signUpUser(app, { email: "strategy-mismatch@example.com" });
    await addVerifiedPhone(ctx, user.userId, "+15550006666");

    const client = testClient(app);
    const created = await client.json<{ response: { id: string } }>("/v1/client/sign_ins", {
      body: { identifier: user.email, strategy: "email_code" },
    });
    await client.json(`/v1/client/sign_ins/${created.response.id}/prepare_first_factor`, { body: { strategy: "email_code" } });
    const code = latestCodeFor(user.email)!;

    const spoofed = await client.json(`/v1/client/sign_ins/${created.response.id}/attempt_first_factor`, {
      body: { strategy: "phone_code", code },
    });
    expect(errorsOf(spoofed)[0]?.code).toBe("client_state_invalid");

    const done = await client.json<{ response: { status: string; created_session_id: string } }>(
      `/v1/client/sign_ins/${created.response.id}/attempt_first_factor`,
      { body: { strategy: "email_code", code } },
    );
    expect(done.response.status).toBe("complete");
    expect(done.response.created_session_id).toMatch(/^sess_/);
  });

  it("fails closed when recovery excluded the only enrolled second factor", async () => {
    const { app, ctx } = await setup();
    await ctx.settings.update({
      mfa: { required: true },
      attributes: {
        emailAddress: { enabled: true, usedForFirstFactor: true, usedForSecondFactor: true, verifications: ["email_code"], verifyAtSignUp: true },
      },
    });
    const user = await signUpUser(app, { email: "only-recovery@example.com" });
    const newPassword = "N3wSup3rSecret!";

    // The normal password flow really does require MFA: the mailbox is the only enrolled second factor.
    const normal = testClient(app);
    const required = await normal.json<{ response: { status: string; supported_second_factors: { strategy: string }[] } }>(
      "/v1/client/sign_ins",
      { body: { identifier: user.email, password: user.password } },
    );
    expect(required.response.status).toBe("needs_second_factor");
    expect(required.response.supported_second_factors.map((f) => f.strategy)).toContain("email_code");

    const client = testClient(app);
    const created = await client.json<{ response: { id: string } }>("/v1/client/sign_ins", {
      body: { identifier: user.email, strategy: "reset_password_email_code" },
    });
    await client.json(`/v1/client/sign_ins/${created.response.id}/prepare_first_factor`, {
      body: { strategy: "reset_password_email_code" },
    });
    const resetCode = latestCodeFor(user.email, "reset_password_code")!;
    await client.json(`/v1/client/sign_ins/${created.response.id}/attempt_first_factor`, {
      body: { strategy: "reset_password_email_code", code: resetCode },
    });

    const reset = await client.json<{
      response: {
        status: string;
        created_session_id: string | null;
        first_factor_verification: { strategy: string; status: string; error?: { code: string } | null } | null;
      };
    }>(`/v1/client/sign_ins/${created.response.id}/reset_password`, {
      body: { password: newPassword, sign_out_of_other_sessions: false },
    });
    // The reset completed, but recovery cannot mint a session without a second factor.
    expect(reset.response.status).toBe("needs_first_factor");
    expect(reset.response.created_session_id).toBeNull();
    expect(reset.response.first_factor_verification?.strategy).toBe("password");
    expect(reset.response.first_factor_verification?.status).toBe("unverified");
    expect(reset.response.first_factor_verification?.error?.code).toBe("needs_second_factor");
    const noSession = await getClient(client);
    expect(noSession.response.sessions).toHaveLength(0);
    expect(noSession.response.last_active_session_id).toBeNull();

    // The password was still changed, and the normal password flow now passes MFA through the mailbox.
    const oldPassword = await testClient(app).json("/v1/client/sign_ins", {
      body: { identifier: user.email, password: user.password },
    });
    expect(errorsOf(oldPassword)[0]?.code).toBe("form_password_incorrect");

    const retry = await client.json<{ response: { status: string; supported_second_factors: { strategy: string }[] } }>(
      `/v1/client/sign_ins/${created.response.id}/attempt_first_factor`,
      { body: { strategy: "password", password: newPassword } },
    );
    expect(retry.response.status).toBe("needs_second_factor");
    expect(retry.response.supported_second_factors.map((f) => f.strategy)).toContain("email_code");
    await client.json(`/v1/client/sign_ins/${created.response.id}/prepare_second_factor`, { body: { strategy: "email_code" } });
    const secondFactorCode = latestCodeFor(user.email)!;
    const done = await client.json<{ response: { status: string; created_session_id: string } }>(
      `/v1/client/sign_ins/${created.response.id}/attempt_second_factor`,
      { body: { strategy: "email_code", code: secondFactorCode } },
    );
    expect(done.response.status).toBe("complete");
    expect(done.response.created_session_id).toMatch(/^sess_/);

    const fresh = testClient(app);
    const again = await fresh.json<{ response: { status: string } }>("/v1/client/sign_ins", {
      body: { identifier: user.email, password: newPassword },
    });
    expect(again.response.status).toBe("needs_second_factor");
  });
});
