import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { scryptSync } from "node:crypto";
import * as schema from "../../src/db/schema";
import { errorsOf, setup, signInWithPassword, signUpUser, testClient } from "./helpers";

describe("first-factor policy", () => {
  it("refuses password sign-in once the instance turns it off", async () => {
    const { app, ctx } = await setup();
    const user = await signUpUser(app);
    await ctx.settings.update({ attributes: { password: { usedForFirstFactor: false } } });

    const client = testClient(app);
    const started = await client.json<{ response: { id: string } }>("/v1/client/sign_ins", { body: { identifier: user.email } });
    const res = await client.request(`/v1/client/sign_ins/${started.response.id}/attempt_first_factor`, { body: { strategy: "password", password: user.password } });
    expect(res.status).toBe(400);
    expect(errorsOf(await res.json())[0]?.code).toBe("strategy_for_user_invalid");
  });

  it("refuses email codes once the instance turns the email identifier off", async () => {
    const { app, ctx } = await setup();
    const user = await signUpUser(app);
    await ctx.settings.update({ attributes: { emailAddress: { usedForFirstFactor: false } } });

    const client = testClient(app);
    const started = await client.json<{ response: { id: string } }>("/v1/client/sign_ins", { body: { identifier: user.email } });
    const res = await client.request(`/v1/client/sign_ins/${started.response.id}/prepare_first_factor`, { body: { strategy: "email_code" } });
    expect(res.status).toBe(400);
  });

  it("signs in a user whose password was imported as a scrypt digest", async () => {
    const { app, ctx } = await setup();
    const user = await signUpUser(app);
    const salt = Buffer.from("orbit-test-salt");
    const key = scryptSync("imported-pass-1", salt, 32, { N: 1024, r: 8, p: 1 });
    const digest = `scrypt$1024$8$1$${salt.toString("base64")}$${key.toString("base64")}`;
    await ctx.db.update(schema.users).set({ passwordHash: digest }).where(eq(schema.users.id, user.userId));

    const signedIn = await signInWithPassword(app, user.email, "imported-pass-1");
    expect(signedIn.sessionId).toMatch(/^sess_/);
  });
});

describe("passkey policy", () => {
  it("refuses passkey sign-in while passkeys are switched off", async () => {
    const { app, ctx } = await setup();
    await ctx.settings.update({ attributes: { passkey: { enabled: false } } });
    const client = testClient(app);
    const started = await client.json<{ response: { id: string } }>("/v1/client/sign_ins", { body: {} });
    const res = await client.request(`/v1/client/sign_ins/${started.response.id}/prepare_first_factor`, { body: { strategy: "passkey" } });
    expect(res.status).toBe(400);
    expect(errorsOf(await res.json())[0]?.code).toBe("strategy_for_user_invalid");
  });
});
