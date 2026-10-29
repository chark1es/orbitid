import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { ErrorCodes, type ActorTokenJSON, type SignInTokenJSON } from "@orbitid/shared";
import { sha256 } from "../../src/lib/crypto";
import * as s from "../../src/db/schema";
import { redeemTicket, validateTicket } from "../../src/services/restrictions";
import { createUser, json, testApp } from "./helpers";

function ticketFromUrl(url: string): string {
  const ticket = new URL(url).searchParams.get("__orbit_ticket");
  if (!ticket) throw new Error(`no ticket in ${url}`);
  return ticket;
}

describe("sign-in tokens & actor tokens", () => {
  it("issues a single-use sign-in token and consumes it via redeemTicket", async () => {
    const { api, ctx } = await testApp();
    const user = await createUser(api);

    const created = await json<SignInTokenJSON>(await api("POST", "/v1/sign_in_tokens", { user_id: user.id }));
    expect(created.object).toBe("sign_in_token");
    expect(created.status).toBe("pending");
    expect(created.user_id).toBe(user.id);
    expect(created.url).toContain("/sign-in?__orbit_ticket=");
    const ticket = ticketFromUrl(created.url!);

    const stored = (await ctx.db.select().from(s.signInTokens))[0]!;
    expect(stored.tokenHash).toBe(sha256(ticket));
    expect(stored.tokenHash).not.toBe(ticket);

    await expect(redeemTicket(ctx, ticket)).resolves.toEqual({ kind: "sign_in_token", userId: user.id });
    expect((await ctx.db.select().from(s.signInTokens))[0]!.status).toBe("accepted");

    await expect(redeemTicket(ctx, ticket)).rejects.toMatchObject({ code: ErrorCodes.ticket_invalid });
    await expect(redeemTicket(ctx, "not-a-ticket")).rejects.toMatchObject({ code: ErrorCodes.ticket_invalid });
  });

  it("honours expiry and revocation", async () => {
    const { api, ctx } = await testApp();
    const user = await createUser(api);

    const expired = await json<SignInTokenJSON>(await api("POST", "/v1/sign_in_tokens", { user_id: user.id, expires_in_seconds: 10 }));
    const expiredTicket = ticketFromUrl(expired.url!);
    await ctx.db.update(s.signInTokens).set({ expiresAt: Date.now() - 1 }).where(eq(s.signInTokens.id, expired.id));
    await expect(validateTicket(ctx, expiredTicket)).rejects.toMatchObject({ code: ErrorCodes.ticket_expired });

    const revoked = await json<SignInTokenJSON>(await api("POST", "/v1/sign_in_tokens", { user_id: user.id }));
    const revokedTicket = ticketFromUrl(revoked.url!);
    const revokeRes = await json<SignInTokenJSON>(await api("POST", `/v1/sign_in_tokens/${revoked.id}/revoke`));
    expect(revokeRes.status).toBe("revoked");
    expect(revokeRes.token).toBeUndefined();
    await expect(redeemTicket(ctx, revokedTicket)).rejects.toMatchObject({ code: ErrorCodes.ticket_invalid });

    expect((await api("POST", "/v1/sign_in_tokens/sit_nope/revoke")).status).toBe(404);
    expect((await api("POST", "/v1/sign_in_tokens", { user_id: user.id, expires_in_seconds: 5 })).status).toBe(422);
  });

  it("issues actor tokens that carry the impersonation actor and session cap", async () => {
    const { api, ctx } = await testApp();
    const user = await createUser(api);

    const created = await json<ActorTokenJSON>(
      await api("POST", "/v1/actor_tokens", { user_id: user.id, actor: { sub: "user_admin" }, expires_in_seconds: 600, session_max_duration_in_seconds: 900 }),
    );
    expect(created.object).toBe("actor_token");
    expect(created.actor).toEqual({ sub: "user_admin" });
    expect(created.status).toBe("pending");
    expect(created.token).toBeTruthy();

    await expect(redeemTicket(ctx, created.token!)).resolves.toEqual({
      kind: "actor_token",
      userId: user.id,
      actor: { sub: "user_admin" },
      sessionMaxDurationSeconds: 900,
    });
    expect((await ctx.db.select().from(s.actorTokens))[0]!.status).toBe("accepted");

    const second = await json<ActorTokenJSON>(await api("POST", "/v1/actor_tokens", { user_id: user.id, actor: { sub: "user_admin", extra: "x" } }));
    const revokedRes = await json<ActorTokenJSON>(await api("POST", `/v1/actor_tokens/${second.id}/revoke`));
    expect(revokedRes.status).toBe("revoked");
    await expect(redeemTicket(ctx, second.token!)).rejects.toMatchObject({ code: ErrorCodes.ticket_invalid });

    expect((await api("POST", "/v1/actor_tokens", { user_id: user.id, actor: {} })).status).toBe(422);
    expect((await api("POST", "/v1/actor_tokens", { user_id: "user_missing", actor: { sub: "a" } })).status).toBe(404);
    expect((await api("POST", "/v1/actor_tokens/act_nope/revoke")).status).toBe(404);
  });
});
