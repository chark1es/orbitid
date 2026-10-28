import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { errorsOf, lastEmailCode, setup, signUpUser } from "./helpers";

const sessionRow = (ctx: Awaited<ReturnType<typeof setup>>["ctx"], id: string) =>
  ctx.db.select().from(schema.sessions).where(eq(schema.sessions.id, id)).get()!;

describe("session reverification", () => {
  it("accepts a first-factor code once and never an arbitrary code afterwards", async () => {
    const { app, ctx } = await setup();
    const user = await signUpUser(app);
    const base = `/v1/client/sessions/${user.sessionId}/verify`;

    await user.client.json(`${base}/prepare_first_factor`, { body: { strategy: "email_code" } });
    const code = lastEmailCode(user.email)!;
    await user.client.json(`${base}/attempt_first_factor`, { body: { strategy: "email_code", code } });
    const verifiedAt = sessionRow(ctx, user.sessionId).firstFactorVerifiedAt!;

    await new Promise((resolve) => setTimeout(resolve, 5));
    const replay = await user.client.json(`${base}/attempt_first_factor`, { body: { strategy: "email_code", code: "000000" } });
    expect(errorsOf(replay)[0]?.code).toBe("form_code_incorrect");
    expect(sessionRow(ctx, user.sessionId).firstFactorVerifiedAt).toBe(verifiedAt);
  });

  it("does not let a first-factor email code satisfy the second factor", async () => {
    const { app, ctx } = await setup();
    const user = await signUpUser(app);
    ctx.db.update(schema.users).set({ totpVerified: true }).where(eq(schema.users.id, user.userId)).run();
    const base = `/v1/client/sessions/${user.sessionId}/verify`;
    const before = sessionRow(ctx, user.sessionId).secondFactorVerifiedAt;

    await user.client.json(`${base}/prepare_first_factor`, { body: { strategy: "email_code" } });
    const code = lastEmailCode(user.email)!;
    const attempt = await user.client.json(`${base}/attempt_second_factor`, { body: { strategy: "phone_code", code } });

    expect(errorsOf(attempt)[0]?.code).toBe("form_code_incorrect");
    expect(sessionRow(ctx, user.sessionId).secondFactorVerifiedAt).toBe(before);
  });
});
