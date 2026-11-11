import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { latestCodeFor } from "../../src/services/mail";
import { errorsOf, setup, signUpUser, testClient, type TestClient } from "../core/helpers";

/**
 * Regression: the UI lets a user start an email-code sign-in and switch to the password screen without
 * preparing the password strategy. Password needs no preparation (it is checked by its own credential
 * verification), so it must not be rejected by the prepared-strategy binding. Code/link/recovery
 * strategies must keep that binding so a prepared attempt cannot be relabelled as another channel.
 */
async function startEmailCodeSignIn(client: TestClient, email: string) {
  const created = await client.json<{ response: { id: string } }>("/v1/client/sign_ins", {
    body: { identifier: email, strategy: "email_code" },
  });
  const signInId = created.response.id;
  await client.json(`/v1/client/sign_ins/${signInId}/prepare_first_factor`, { body: { strategy: "email_code" } });
  return signInId;
}

describe("first-factor strategy switching", () => {
  it("accepts a password attempt after an email code was prepared", async () => {
    const { app } = await setup();
    const user = await signUpUser(app, { email: "switch-to-password@example.com" });
    const client = testClient(app);
    const signInId = await startEmailCodeSignIn(client, user.email);
    const code = latestCodeFor(user.email)!;

    // The binding still protects prepared code strategies: a code issued for email cannot be submitted
    // under the phone strategy.
    const spoofed = await client.json(`/v1/client/sign_ins/${signInId}/attempt_first_factor`, {
      body: { strategy: "phone_code", code },
    });
    expect(errorsOf(spoofed)[0]?.code).toBe("client_state_invalid");

    // The same sign-in can complete with the account password without preparing `password` first.
    const done = await client.json<{ response: { status: string; created_session_id: string; first_factor_verification: { strategy: string; status: string } | null } }>(
      `/v1/client/sign_ins/${signInId}/attempt_first_factor`,
      { body: { strategy: "password", password: user.password } },
    );
    expect(done.response.status).toBe("complete");
    expect(done.response.created_session_id).toMatch(/^sess_/);
    expect(done.response.first_factor_verification?.strategy).toBe("password");
    expect(done.response.first_factor_verification?.status).toBe("verified");
  });

  it("lets a user switch code -> password -> code by preparing the code again", async () => {
    const { app, ctx } = await setup();
    const user = await signUpUser(app, { email: "switch-back-to-code@example.com" });
    const client = testClient(app);
    const signInId = await startEmailCodeSignIn(client, user.email);
    const firstCode = latestCodeFor(user.email)!;

    // A wrong password is handled by the password verifier (not the strategy gate) and counts toward lockout.
    const wrong = await client.json(`/v1/client/sign_ins/${signInId}/attempt_first_factor`, {
      body: { strategy: "password", password: "NotThePassword1!" },
    });
    expect(errorsOf(wrong)[0]?.code).toBe("form_password_incorrect");
    const userRow = (await ctx.db.select().from(schema.users).where(eq(schema.users.id, user.userId)))[0]!;
    expect(userRow.failedAttempts).toBe(1);

    // Switching back to email re-prepares the code: the old one is invalidated and a fresh one is issued.
    await client.json(`/v1/client/sign_ins/${signInId}/prepare_first_factor`, { body: { strategy: "email_code" } });
    const secondCode = latestCodeFor(user.email)!;
    expect(secondCode).not.toBe(firstCode);

    // The re-prepare invalidated the earlier code: only the newest one can verify this sign-in.
    const stale = await client.json(`/v1/client/sign_ins/${signInId}/attempt_first_factor`, {
      body: { strategy: "email_code", code: firstCode },
    });
    expect(errorsOf(stale)[0]?.code).toBe("form_code_incorrect");

    const done = await client.json<{ response: { status: string; created_session_id: string } }>(
      `/v1/client/sign_ins/${signInId}/attempt_first_factor`,
      { body: { strategy: "email_code", code: secondCode } },
    );
    expect(done.response.status).toBe("complete");
    expect(done.response.created_session_id).toMatch(/^sess_/);
  });

  it("counts password failures under a prepared email code toward the account lockout", async () => {
    const { app, ctx } = await setup();
    await ctx.settings.update({ mfa: { maxAttempts: 3, lockoutDurationSeconds: 60 } });
    const user = await signUpUser(app, { email: "switch-lockout@example.com" });
    const client = testClient(app);
    const signInId = await startEmailCodeSignIn(client, user.email);

    for (let attempt = 0; attempt < 3; attempt++) {
      const failed = await client.json(`/v1/client/sign_ins/${signInId}/attempt_first_factor`, {
        body: { strategy: "password", password: `WrongPassword-${attempt}!` },
      });
      expect(errorsOf(failed)[0]?.code).toBe("form_password_incorrect");
    }

    // The failure counter is the same one the password sign-in endpoint uses, so the account is now locked
    // even though the sign-in still has an email code prepared.
    const blocked = await client.json(`/v1/client/sign_ins/${signInId}/attempt_first_factor`, {
      body: { strategy: "password", password: user.password },
    });
    expect(errorsOf(blocked)[0]?.code).toBe("user_locked");
  });
});
