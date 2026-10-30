import { describe, it, expect, vi } from "vitest";
import type { ClientJSON, PaginatedList, SessionJSON } from "@orbitid/shared";
import * as s from "../../src/db/schema";
import { createSessionFixture, createUser, json, sessionJwtFor, testApp, type ErrorBody } from "./helpers";

// Session JWTs are minted by the core worker; the endpoint contract is the request it makes.
const { signSessionToken } = vi.hoisted(() => ({
  signSessionToken: vi.fn(async (_ctx: unknown, sessionId: string, opts: { template?: string } = {}) => `jwt:${sessionId}:${opts.template ?? "default"}`),
}));
vi.mock("../../src/services/tokens", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/tokens")>()),
  signSessionToken,
}));

describe("sessions & clients", () => {
  it("lists, reads, revokes sessions and refuses to assert their factors", async () => {
    const { api, ctx } = await testApp();
    const user = await createUser(api);
    const other = await createUser(api);
    const first = await createSessionFixture(ctx, user.id);
    const second = await createSessionFixture(ctx, user.id, { status: "revoked" });
    await createSessionFixture(ctx, other.id);

    const list = await json<PaginatedList<SessionJSON>>(await api("GET", `/v1/sessions?user_id=${user.id}`));
    expect(list.total_count).toBe(2);
    expect(list.data.every((session) => session.public_user_data?.user_id === user.id)).toBe(true);

    expect((await json<PaginatedList<SessionJSON>>(await api("GET", `/v1/sessions?user_id=${user.id}&status=active`))).data.map((s) => s.id)).toEqual([first.sessionId]);
    expect((await json<PaginatedList<SessionJSON>>(await api("GET", `/v1/sessions?client_id=${second.clientId}`))).data.map((s) => s.id)).toEqual([second.sessionId]);

    const detail = await json<SessionJSON>(await api("GET", `/v1/sessions/${first.sessionId}`));
    expect(detail.object).toBe("session");
    expect(detail.status).toBe("active");
    expect(detail.user?.id).toBe(user.id);
    expect(detail.factor_verification_age).toEqual([-1, -1]);
    expect((await api("GET", "/v1/sessions/sess_nope")).status).toBe(404);

    const verified = await api("POST", `/v1/sessions/${first.sessionId}/verify`);
    expect(verified.status).toBe(403);
    expect(((await verified.json()) as { errors: { code: string }[] }).errors[0]!.code).toBe("not_allowed_access");
    // The session's own factor ages are untouched: the operator cannot assert a factor the browser never presented.
    const unchanged = await json<SessionJSON>(await api("GET", `/v1/sessions/${first.sessionId}`));
    expect(unchanged.factor_verification_age).toEqual([-1, -1]);

    const revoked = await json<SessionJSON>(await api("POST", `/v1/sessions/${second.sessionId}/revoke`));
    expect(revoked.status).toBe("revoked");
    expect((await ctx.db.select().from(s.sessions))).toHaveLength(3);
  });

  it("mints session tokens only for a caller that already holds that session's token", async () => {
    const { api, ctx } = await testApp();
    const user = await createUser(api);
    const other = await createUser(api);
    const { sessionId } = await createSessionFixture(ctx, user.id);
    const otherSession = await createSessionFixture(ctx, other.id);
    await api("POST", "/v1/jwt_templates", { name: "with-email", claims: { email: "{{user.primary_email_address}}" } });

    // A secret key alone cannot mint a user's session: that would be sign-in-as-user with one request.
    const noProof = await api("POST", `/v1/sessions/${sessionId}/tokens`);
    expect(noProof.status).toBe(403);
    expect((await json<ErrorBody>(noProof)).errors[0]!.code).toBe("not_allowed_access");

    // A token for another session is not a proof for this one.
    const otherJwt = await sessionJwtFor(ctx, otherSession.sessionId, other.id);
    const wrongSession = await api("POST", `/v1/sessions/${sessionId}/tokens`, undefined, { "x-orbitid-session-token": otherJwt });
    expect(wrongSession.status).toBe(403);

    const proved = await sessionJwtFor(ctx, sessionId, user.id);
    const auth = { "x-orbitid-session-token": proved };
    const plain = await json<{ object: string; jwt: string }>(await api("POST", `/v1/sessions/${sessionId}/tokens`, undefined, auth));
    expect(plain).toEqual({ object: "token", jwt: `jwt:${sessionId}:default` });

    const templated = await json<{ object: string; jwt: string }>(await api("POST", `/v1/sessions/${sessionId}/tokens/with-email`, undefined, auth));
    expect(templated.jwt).toBe(`jwt:${sessionId}:with-email`);
    expect(signSessionToken).toHaveBeenLastCalledWith(ctx, sessionId, { template: "with-email" });

    expect((await api("POST", `/v1/sessions/${sessionId}/tokens/missing`, undefined, auth)).status).toBe(404);

    // A forged token is refused rather than minting anything.
    const forged = await api("POST", `/v1/sessions/${sessionId}/tokens`, undefined, { "x-orbitid-session-token": "not.a.jwt" });
    expect(forged.status).toBe(403);

    const ended = await createSessionFixture(ctx, user.id, { status: "ended" });
    const endedJwt = await sessionJwtFor(ctx, ended.sessionId, user.id);
    const inactive = await api("POST", `/v1/sessions/${ended.sessionId}/tokens`, undefined, { "x-orbitid-session-token": endedJwt });
    expect(inactive.status).toBe(400);
    expect((await json<ErrorBody>(inactive)).errors[0]!.code).toBe("authentication_invalid");
  });

  it("exposes clients by id and by cookie token without handing out session JWTs", async () => {
    const { api, ctx } = await testApp();
    const user = await createUser(api);
    const { clientId, token, sessionId } = await createSessionFixture(ctx, user.id);

    const client = await json<ClientJSON>(await api("GET", `/v1/clients/${clientId}`));
    expect(client.object).toBe("client");
    expect(client.sessions.map((s) => s.id)).toEqual([sessionId]);
    // The Backend API does not mint a fresh JWT for somebody else's client: that would be a working session.
    expect(client.sessions[0]!.last_active_token).toBeNull();

    const verified = await json<ClientJSON>(await api("POST", "/v1/clients/verify", { token }));
    expect(verified.id).toBe(clientId);
    expect(verified.sessions[0]!.last_active_token).toBeNull();

    expect((await api("POST", "/v1/clients/verify", { token: "nope" })).status).toBe(404);
    expect((await api("GET", "/v1/clients/client_nope")).status).toBe(404);
  });
});
