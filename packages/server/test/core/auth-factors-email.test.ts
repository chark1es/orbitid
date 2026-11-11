// Email code as a second factor.
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { first } from "../../src/lib/db";
import { latestCodeFor } from "../../src/services/mail";
import { errorsOf, setup, signUpUser, testClient } from "./helpers";
import { enableEmailSecondFactor, enableTotp, startSignIn } from "./auth-factors-helpers";
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

  it("verifies the secondary email chosen at prepare time, not the first verified address", async () => {
    const { app, ctx } = await setup();
    await enableEmailSecondFactor(ctx);
    const user = await signUpUser(app);

    const second = await user.client.json<{ response: { id: string; email_address: string } }>("/v1/client/me/email_addresses", {
      body: { email_address: "second@example.com" },
    });
    await user.client.json(`/v1/client/me/email_addresses/${second.response.id}/prepare_verification`, { body: {} });
    const verifyCode = latestCodeFor(second.response.email_address);
    await user.client.json(`/v1/client/me/email_addresses/${second.response.id}/attempt_verification`, { body: { code: verifyCode } });

    const client = testClient(app);
    const created = await client.json<{ response: { id: string; supported_second_factors: { strategy: string; email_address_id?: string }[] } }>(
      "/v1/client/sign_ins",
      { body: { identifier: user.email, password: user.password } },
    );
    // Both verified addresses are offered; choose the second one.
    expect(created.response.supported_second_factors.filter((f) => f.strategy === "email_code")).toHaveLength(2);
    await client.json(`/v1/client/sign_ins/${created.response.id}/prepare_second_factor`, {
      body: { strategy: "email_code", email_address_id: second.response.id },
    });
    const code = latestCodeFor(second.response.email_address);
    expect(code).toMatch(/^\d{6}$/);

    const done = await client.json<{ response: { status: string } }>(`/v1/client/sign_ins/${created.response.id}/attempt_second_factor`, {
      body: { strategy: "email_code", code },
    });
    expect(done.response.status).toBe("complete");
  });

  it("is listed in the environment's second_factors", async () => {
    const { app, ctx } = await setup();
    await enableEmailSecondFactor(ctx);
    const client = testClient(app);
    const env = await client.json<{ auth_config: { second_factors: string[] } }>("/v1/client/environment");
    expect(env.auth_config.second_factors).toContain("email_code");
  });
});
