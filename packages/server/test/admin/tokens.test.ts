import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { ErrorCodes } from "@orbitid/shared";
import { sha256 } from "../../src/lib/crypto";
import * as s from "../../src/db/schema";
import { redeemTicket, validateTicket } from "../../src/services/restrictions";
import { createUser, testApp } from "./helpers";

/**
 * Impersonation and operator-minted sign-in tokens were removed. These tests prove both halves of that: the
 * minting endpoints are gone (so no credential can be created) and tickets that already exist in the database
 * cannot be redeemed for a session.
 */
describe("operator session minting is denied", () => {
  it("refuses to create a sign-in or actor token and reports a typed 403", async () => {
    const { api } = await testApp();
    const user = await createUser(api);

    const requests: [string, unknown][] = [
      ["/v1/sign_in_tokens", { user_id: user.id }],
      ["/v1/sign_in_tokens/sit_whatever/revoke", undefined],
      ["/v1/actor_tokens", { user_id: user.id, actor: { sub: "user_admin" } }],
      ["/v1/actor_tokens/act_whatever/revoke", undefined],
    ];
    for (const [path, body] of requests) {
      const res = await api("POST", path, body);
      expect(res.status, path).toBe(403);
      const payload = (await res.json()) as { errors: { code: string; message: string }[] };
      expect(payload.errors[0]!.code).toBe(ErrorCodes.not_allowed_access);
      // The message tells the operator what to do instead of just "no".
      expect(payload.errors[0]!.message).toMatch(/impersonation/i);
    }
  });

  it("does not write a token row even when the request would otherwise be valid", async () => {
    const { api, ctx } = await testApp();
    const user = await createUser(api);
    await api("POST", "/v1/sign_in_tokens", { user_id: user.id });
    await api("POST", "/v1/actor_tokens", { user_id: user.id, actor: { sub: "x" } });
    expect(await ctx.db.select().from(s.signInTokens)).toHaveLength(0);
    expect(await ctx.db.select().from(s.actorTokens)).toHaveLength(0);
  });

  it("still requires the secret key, so an unauthenticated attempt is a 401", async () => {
    const { app } = await testApp();
    const res = await app.request("/v1/sign_in_tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: "user_1" }),
    });
    expect(res.status).toBe(401);
  });

  it("refuses pre-existing sign-in and actor tickets instead of redeeming them", async () => {
    const { api, ctx } = await testApp();
    const user = await createUser(api);
    const now = Date.now();
    await ctx.db.insert(s.signInTokens).values({
      id: "sit_legacy", userId: user.id, tokenHash: sha256("legacy-sign-in-ticket"), status: "pending",
      expiresAt: now + 60_000, createdAt: now, updatedAt: now,
    });
    await ctx.db.insert(s.actorTokens).values({
      id: "act_legacy", userId: user.id, actor: { sub: "operator_1" }, tokenHash: sha256("legacy-actor-ticket"), status: "pending",
      expiresAt: now + 60_000, sessionMaxDurationSeconds: 600, createdAt: now, updatedAt: now,
    });

    for (const ticket of ["legacy-sign-in-ticket", "legacy-actor-ticket"]) {
      await expect(validateTicket(ctx, ticket), ticket).rejects.toMatchObject({ code: ErrorCodes.ticket_invalid });
      await expect(redeemTicket(ctx, ticket), ticket).rejects.toMatchObject({ code: ErrorCodes.ticket_invalid });
    }
    // Validation is a read: the rows keep their status, so a second attempt fails the same way.
    expect((await ctx.db.select().from(s.signInTokens).where(eq(s.signInTokens.id, "sit_legacy")))[0]!.status).toBe("pending");
    expect((await ctx.db.select().from(s.actorTokens).where(eq(s.actorTokens.id, "act_legacy")))[0]!.status).toBe("pending");
  });

  it("does not accept a ticket through the Frontend API sign-in route", async () => {
    const { app, ctx, fapi } = await testApp();
    const now = Date.now();
    const user = await createUser((method, path, body) => Promise.resolve(app.request(path, {
      method,
      headers: { authorization: "Bearer sk_test_testsecret", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })));
    await ctx.db.insert(s.signInTokens).values({
      id: "sit_api", userId: user.id, tokenHash: sha256("api-ticket"), status: "pending", expiresAt: now + 60_000, createdAt: now, updatedAt: now,
    });
    const res = await fapi("POST", "/v1/client/sign_ins", { ticket: "api-ticket" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { errors: { code: string }[] }).errors[0]!.code).toBe(ErrorCodes.ticket_invalid);
  });
});
