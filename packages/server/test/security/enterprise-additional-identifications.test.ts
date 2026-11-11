// Regression coverage for enterprise connections that disable additional identifications:
// auto-linking, recovery passwords and passkey registration must all honour the policy.
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { AppContext } from "../../src/context";
import * as s from "../../src/db/schema";
import { first } from "../../src/lib/db";
import { assertAdditionalIdentificationsAllowed } from "../../src/services/enterprise-access";
import { handleExternalIdentity } from "../../src/services/external-identity";
import { latestCodeFor } from "../../src/services/mail";
import { errorsOf, setup, signUpUser, testClient } from "../core/helpers";
import { APP_ORIGIN, beginRegistration, enablePasskeys } from "../passkeys-helpers";

interface ConnectionOptions {
  id: string;
  restricted?: boolean;
  createdAt?: number;
}

/** Links a local user to an enterprise connection through an external account, as SSO would. */
async function linkConnection(ctx: AppContext, userId: string, email: string, opts: ConnectionOptions) {
  const now = opts.createdAt ?? Date.now();
  await ctx.db.insert(s.enterpriseConnections).values({
    id: opts.id,
    name: opts.id,
    protocol: "oidc",
    provider: "custom",
    domains: [],
    active: true,
    disableAdditionalIdentifications: opts.restricted ?? false,
    config: {},
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.insert(s.externalAccounts).values({
    id: `eac_${opts.id}`,
    userId,
    provider: `oidc_${opts.id}`,
    providerUserId: `subject_${opts.id}`,
    emailAddress: email,
    firstName: "Test",
    lastName: "User",
    approvedScopes: "",
    createdAt: now,
    updatedAt: now,
  });
}

async function restrictedUser(app: ReturnType<typeof import("../../src/app").createApp>, ctx: AppContext, email: string) {
  const user = await signUpUser(app, { email });
  await linkConnection(ctx, user.userId, user.email, { id: "ent_restricted", restricted: true });
  return user;
}

describe("enterprise connections with disable_additional_identifications", () => {
  it("refuses to auto-link a social identity during sign-in", async () => {
    const { app, ctx } = await setup();
    const user = await restrictedUser(app, ctx, "signin@example.com");
    const client = first(await ctx.db.select().from(s.clients))!;

    const result = await handleExternalIdentity(
      ctx,
      { clientId: client.id, kind: "sign_in", redirectUrl: "http://localhost:3000/done" },
      { provider: "google", providerUserId: "g-auto", email: user.email, emailVerified: true },
    );
    expect(result.redirectTo).toContain("__orbit_error=not_allowed_access");
    expect((await ctx.db.select().from(s.externalAccounts)).filter((account) => account.provider === "google")).toHaveLength(0);
  });

  it("refuses to auto-link a social identity during sign-up", async () => {
    const { app, ctx } = await setup();
    const user = await restrictedUser(app, ctx, "signup@example.com");
    const browser = testClient(app);
    const started = await browser.json<{ response: { id: string } }>("/v1/client/sign_ups", { body: {} });
    const signUp = first(await ctx.db.select().from(s.signUps).where(eq(s.signUps.id, started.response.id)))!;

    const result = await handleExternalIdentity(
      ctx,
      { clientId: signUp.clientId, kind: "sign_up", ownerId: started.response.id, redirectUrl: "http://localhost:3000/done" },
      { provider: "github", providerUserId: "gh-auto", email: user.email, emailVerified: true },
    );
    expect(result.redirectTo).toContain("__orbit_error=not_allowed_access");
    expect((await ctx.db.select().from(s.externalAccounts)).filter((account) => account.provider === "github")).toHaveLength(0);
  });

  it("refuses to create a password through account recovery", async () => {
    const { app, ctx } = await setup();
    const user = await restrictedUser(app, ctx, "recovery@example.com");
    const browser = testClient(app);
    const created = await browser.json<{ response: { id: string } }>("/v1/client/sign_ins", {
      body: { identifier: user.email, strategy: "reset_password_email_code" },
    });
    await browser.json(`/v1/client/sign_ins/${created.response.id}/prepare_first_factor`, {
      body: { strategy: "reset_password_email_code" },
    });
    const code = latestCodeFor(user.email, "reset_password_code");
    await browser.json(`/v1/client/sign_ins/${created.response.id}/attempt_first_factor`, {
      body: { strategy: "reset_password_email_code", code },
    });

    const reset = await browser.request(`/v1/client/sign_ins/${created.response.id}/reset_password`, {
      body: { password: "N3wSup3rSecret!", sign_out_of_other_sessions: false },
    });
    expect(reset.status).toBe(403);
    expect(errorsOf(await reset.json())[0]?.code).toBe("not_allowed_access");
  });

  it("refuses to start passkey registration", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const user = await restrictedUser(app, ctx, "passkey-start@example.com");

    const res = await user.client.request("/v1/client/me/passkeys", { body: {}, headers: { origin: APP_ORIGIN } });
    expect(res.status).toBe(403);
    expect(errorsOf(await res.json())[0]?.code).toBe("not_allowed_access");
  });

  it("refuses to complete passkey registration that started before the policy applied", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const user = await signUpUser(app, { email: "passkey-finish@example.com" });
    const begun = await beginRegistration(user.client);
    await linkConnection(ctx, user.userId, user.email, { id: "ent_late", restricted: true });

    const res = await user.client.request(`/v1/client/me/passkeys/${begun.response.id}/attempt_verification`, {
      body: { public_key_credential: {} },
      headers: { origin: APP_ORIGIN },
    });
    expect(res.status).toBe(403);
    expect(errorsOf(await res.json())[0]?.code).toBe("not_allowed_access");
  });

  it("rejects additions when any linked connection forbids them, not only the first one", async () => {
    const { app, ctx } = await setup();
    const user = await signUpUser(app, { email: "multi-link@example.com" });
    await linkConnection(ctx, user.userId, user.email, { id: "ent_open", createdAt: Date.now() - 1_000 });
    await linkConnection(ctx, user.userId, user.email, { id: "ent_closed", restricted: true });

    await expect(assertAdditionalIdentificationsAllowed(ctx, user.userId)).rejects.toMatchObject({ code: "not_allowed_access" });
    const res = await user.client.request("/v1/client/me/change_password", {
      body: { current_password: user.password, new_password: "N3wSup3rSecret!" },
    });
    expect(res.status).toBe(403);
    expect(errorsOf(await res.json())[0]?.code).toBe("not_allowed_access");
  });
});
