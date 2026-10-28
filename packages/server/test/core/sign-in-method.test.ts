import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { authMethodOf } from "../../src/lib/auth-method";
import { lastEmailCode, setup, signInWithPassword, signUpUser, testClient } from "./helpers";

describe("sign-in method on sessions", () => {
  const methodOf = async (ctx: Awaited<ReturnType<typeof setup>>["ctx"], sessionId: string) =>
    (await ctx.db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)))[0]?.authMethod;

  it("records how each session was created", async () => {
    const { app, ctx } = await setup();
    const user = await signUpUser(app);
    expect(await methodOf(ctx, user.sessionId)).toBe("email_code");

    const password = await signInWithPassword(app, user.email, user.password);
    expect(await methodOf(ctx, password.sessionId)).toBe("password");

    const client = testClient(app);
    const started = await client.json<{ response: { id: string } }>("/v1/client/sign_ins", { body: { identifier: user.email, strategy: "email_code" } });
    await client.json(`/v1/client/sign_ins/${started.response.id}/prepare_first_factor`, { body: { strategy: "email_code" } });
    const done = await client.json<{ response: { created_session_id: string } }>(`/v1/client/sign_ins/${started.response.id}/attempt_first_factor`, {
      body: { strategy: "email_code", code: lastEmailCode(user.email)! },
    });
    expect(await methodOf(ctx, done.response.created_session_id)).toBe("email_code");
  });

  it("exposes it on the session resource", async () => {
    const { app } = await setup();
    const user = await signUpUser(app);
    const state = await user.client.json<{ response: { sessions: { sign_in_method: string | null }[] } }>("/v1/client");
    expect(state.response.sessions[0]?.sign_in_method).toBe("email_code");
  });

  it("maps strategies to methods", () => {
    expect(authMethodOf("oauth_google")).toBe("oauth");
    expect(authMethodOf("phone_code")).toBe("sms");
    expect(authMethodOf("enterprise_sso")).toBe("sso");
    expect(authMethodOf("reset_password_email_code")).toBe("password");
    expect(authMethodOf("totp")).toBeNull();
    expect(authMethodOf(undefined)).toBeNull();
  });
});
