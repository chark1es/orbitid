import { describe, expect, it } from "vitest";
import { authenticator } from "otplib";
import * as schema from "../../src/db/schema";
import { getSmsOutbox, latestCodeFor, latestLinkFor } from "../../src/services/mail";
import { errorsOf, setup, signUpUser, testClient, type TestClient } from "../core/helpers";

const pathOf = (url: string) => {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
};

const uniquePhone = () => `+1555${String(Math.floor(Math.random() * 1_000_000)).padStart(7, "0")}`;

/** Enrols TOTP through the profile API and returns the shared secret. */
async function enableTotp(client: TestClient) {
  const started = await client.json<{ response: { secret: string } }>("/v1/client/me/totp", { body: {} });
  await client.json("/v1/client/me/totp/attempt_verification", {
    body: { code: authenticator.generate(started.response.secret) },
  });
  return started.response.secret;
}

describe("first-factor verifications are single use", () => {
  it("does not reopen a completed password reset when the recovery code is replayed", async () => {
    const { app } = await setup();
    const user = await signUpUser(app, { email: "replay-recovery@example.com" });
    await enableTotp(user.client);

    const client = testClient(app);
    const created = await client.json<{ response: { id: string } }>("/v1/client/sign_ins", {
      body: { identifier: user.email, strategy: "reset_password_email_code" },
    });
    const signInId = created.response.id;
    await client.json(`/v1/client/sign_ins/${signInId}/prepare_first_factor`, {
      body: { strategy: "reset_password_email_code" },
    });
    const code = latestCodeFor(user.email, "reset_password_code")!;
    const verified = await client.json<{ response: { status: string } }>(`/v1/client/sign_ins/${signInId}/attempt_first_factor`, {
      body: { strategy: "reset_password_email_code", code },
    });
    expect(verified.response.status).toBe("needs_new_password");

    const reset = await client.json<{ response: { status: string } }>(`/v1/client/sign_ins/${signInId}/reset_password`, {
      body: { password: "N3wSup3rSecret!", sign_out_of_other_sessions: false },
    });
    expect(reset.response.status).toBe("needs_second_factor");

    // Replaying the spent recovery code must not hand the same sign-in a second password reset.
    const replay = await client.json(`/v1/client/sign_ins/${signInId}/attempt_first_factor`, {
      body: { strategy: "reset_password_email_code", code },
    });
    expect(errorsOf(replay)[0]?.code).toBe("client_state_invalid");

    const afterReplay = await client.json<{
      response: { status: string; first_factor_verification: { strategy: string; status: string } | null };
    }>(`/v1/client/sign_ins/${signInId}`);
    expect(afterReplay.response.status).toBe("needs_second_factor");
    expect(afterReplay.response.first_factor_verification?.strategy).toBe("reset_password_email_code");
    expect(afterReplay.response.first_factor_verification?.status).toBe("verified");

    // A spent authorization cannot be prepared again while the sign-in waits for MFA.
    const prepared = await client.json(`/v1/client/sign_ins/${signInId}/prepare_first_factor`, {
      body: { strategy: "reset_password_email_code" },
    });
    expect(errorsOf(prepared)[0]?.code).toBe("client_state_invalid");

    // The reset endpoint still refuses a second change.
    const secondReset = await client.json(`/v1/client/sign_ins/${signInId}/reset_password`, {
      body: { password: "Hij4cked-Pass!", sign_out_of_other_sessions: false },
    });
    expect(errorsOf(secondReset)[0]?.code).toBe("client_state_invalid");

    // Prove the second password never took effect: the first reset password is the live one.
    const hijacked = await testClient(app).json("/v1/client/sign_ins", {
      body: { identifier: user.email, password: "Hij4cked-Pass!" },
    });
    expect(errorsOf(hijacked)[0]?.code).toBe("form_password_incorrect");
    const current = await testClient(app).json<{ response: { status: string } }>("/v1/client/sign_ins", {
      body: { identifier: user.email, password: "N3wSup3rSecret!" },
    });
    expect(current.response.status).toBe("needs_second_factor");
  });

  it("applies a recovery reset once when parallel requests replay the same authorization", async () => {
    const { app } = await setup();
    const user = await signUpUser(app, { email: "replay-race@example.com" });
    await enableTotp(user.client);

    const client = testClient(app);
    const created = await client.json<{ response: { id: string } }>("/v1/client/sign_ins", {
      body: { identifier: user.email, strategy: "reset_password_email_code" },
    });
    const signInId = created.response.id;
    await client.json(`/v1/client/sign_ins/${signInId}/prepare_first_factor`, {
      body: { strategy: "reset_password_email_code" },
    });
    const code = latestCodeFor(user.email, "reset_password_code")!;
    await client.json(`/v1/client/sign_ins/${signInId}/attempt_first_factor`, {
      body: { strategy: "reset_password_email_code", code },
    });

    const results = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      client.request(`/v1/client/sign_ins/${signInId}/reset_password`, {
        body: { password: `N3wSup3rSecret-${i}!`, sign_out_of_other_sessions: false },
      })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 400)).toHaveLength(5);

    // The authorization stays spent: the code cannot be replayed into another reset.
    const replay = await client.json(`/v1/client/sign_ins/${signInId}/attempt_first_factor`, {
      body: { strategy: "reset_password_email_code", code },
    });
    expect(errorsOf(replay)[0]?.code).toBe("client_state_invalid");
    const pending = await client.json<{ response: { status: string } }>(`/v1/client/sign_ins/${signInId}`);
    expect(pending.response.status).toBe("needs_second_factor");
  });

  it("rejects an email code replay after it escalated to the second factor", async () => {
    const { app } = await setup();
    const user = await signUpUser(app, { email: "replay-email@example.com" });
    const secret = await enableTotp(user.client);

    const client = testClient(app);
    const created = await client.json<{ response: { id: string } }>("/v1/client/sign_ins", {
      body: { identifier: user.email },
    });
    const signInId = created.response.id;
    await client.json(`/v1/client/sign_ins/${signInId}/prepare_first_factor`, { body: { strategy: "email_code" } });
    const code = latestCodeFor(user.email)!;
    const escalated = await client.json<{ response: { status: string } }>(
      `/v1/client/sign_ins/${signInId}/attempt_first_factor`,
      { body: { strategy: "email_code", code } },
    );
    expect(escalated.response.status).toBe("needs_second_factor");

    // The code was already spent on this sign-in: replaying it cannot re-verify the first factor.
    const replay = await client.json(`/v1/client/sign_ins/${signInId}/attempt_first_factor`, {
      body: { strategy: "email_code", code },
    });
    expect(errorsOf(replay)[0]?.code).toBe("client_state_invalid");
    const prepared = await client.json(`/v1/client/sign_ins/${signInId}/prepare_first_factor`, { body: { strategy: "email_code" } });
    expect(errorsOf(prepared)[0]?.code).toBe("client_state_invalid");

    // The sign-in still waits for the genuine second factor, and it completes normally.
    await client.json(`/v1/client/sign_ins/${signInId}/prepare_second_factor`, { body: { strategy: "totp" } });
    const done = await client.json<{ response: { status: string; created_session_id: string } }>(
      `/v1/client/sign_ins/${signInId}/attempt_second_factor`,
      { body: { strategy: "totp", code: authenticator.generate(secret) } },
    );
    expect(done.response.status).toBe("complete");
    expect(done.response.created_session_id).toMatch(/^sess_/);

    // Nor can the spent code be replayed once the sign-in is complete.
    const completedReplay = await client.json(`/v1/client/sign_ins/${signInId}/attempt_first_factor`, {
      body: { strategy: "email_code", code },
    });
    expect(errorsOf(completedReplay)[0]?.code).toBe("client_state_invalid");
  });

  it("rejects a phone code replay after the sign-in completed", async () => {
    const { app, ctx } = await setup();
    await ctx.settings.update({
      attributes: { phoneNumber: { enabled: true, usedForFirstFactor: true, verifications: ["phone_code"] } },
    });
    const user = await signUpUser(app, { email: "replay-phone@example.com" });
    const phone = uniquePhone();
    const now = Date.now();
    await ctx.db.insert(schema.phoneNumbers).values({
      id: `idn_p_${Math.random().toString(36).slice(2, 10)}`,
      userId: user.userId,
      phone,
      verified: true,
      verifiedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const client = testClient(app);
    const created = await client.json<{ response: { id: string } }>("/v1/client/sign_ins", {
      body: { identifier: phone, strategy: "phone_code" },
    });
    const signInId = created.response.id;
    await client.json(`/v1/client/sign_ins/${signInId}/prepare_first_factor`, { body: { strategy: "phone_code" } });
    const code = /(\d{6})/.exec(getSmsOutbox().at(-1)!.body)?.[1]!;
    const done = await client.json<{ response: { status: string; created_session_id: string } }>(
      `/v1/client/sign_ins/${signInId}/attempt_first_factor`,
      { body: { strategy: "phone_code", code } },
    );
    expect(done.response.status).toBe("complete");
    expect(done.response.created_session_id).toMatch(/^sess_/);

    const replay = await client.json(`/v1/client/sign_ins/${signInId}/attempt_first_factor`, {
      body: { strategy: "phone_code", code },
    });
    expect(errorsOf(replay)[0]?.code).toBe("client_state_invalid");
    const prepared = await client.json(`/v1/client/sign_ins/${signInId}/prepare_first_factor`, { body: { strategy: "phone_code" } });
    expect(errorsOf(prepared)[0]?.code).toBe("client_state_invalid");
  });

  it("rejects replaying a spent magic-link attempt after the sign-in completed", async () => {
    const { app } = await setup();
    const user = await signUpUser(app, { email: "replay-link@example.com" });

    const client = testClient(app);
    const created = await client.json<{ response: { id: string } }>("/v1/client/sign_ins", {
      body: { identifier: user.email, strategy: "email_link" },
    });
    const signInId = created.response.id;
    await client.json(`/v1/client/sign_ins/${signInId}/prepare_first_factor`, { body: { strategy: "email_link" } });
    const landing = await client.request(pathOf(latestLinkFor(user.email)!));
    expect(landing.status).toBe(302);

    const done = await client.json<{ response: { status: string; created_session_id: string } }>(`/v1/client/sign_ins/${signInId}`);
    expect(done.response.status).toBe("complete");
    expect(done.response.created_session_id).toMatch(/^sess_/);

    // Polling the spent link flow again cannot re-open the first factor.
    const replay = await client.json(`/v1/client/sign_ins/${signInId}/attempt_first_factor`, { body: { strategy: "email_link" } });
    expect(errorsOf(replay)[0]?.code).toBe("client_state_invalid");
    const prepared = await client.json(`/v1/client/sign_ins/${signInId}/prepare_first_factor`, { body: { strategy: "email_link" } });
    expect(errorsOf(prepared)[0]?.code).toBe("client_state_invalid");
  });
});
