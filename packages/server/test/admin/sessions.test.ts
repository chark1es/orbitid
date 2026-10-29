import { describe, it, expect, vi } from "vitest";
import type { ClientJSON, PaginatedList, SessionJSON } from "@orbitid/shared";
import * as s from "../../src/db/schema";
import { createSessionFixture, createUser, json, testApp, type ErrorBody } from "./helpers";

// Session JWTs are minted by the core worker; the endpoint contract is the request it makes.
const { signSessionToken } = vi.hoisted(() => ({
  signSessionToken: vi.fn(async (_ctx: unknown, sessionId: string, opts: { template?: string } = {}) => `jwt:${sessionId}:${opts.template ?? "default"}`),
}));
vi.mock("../../src/services/tokens", () => ({ signSessionToken }));

describe("sessions & clients", () => {
  it("lists, reads, revokes and verifies sessions", async () => {
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

    const verified = await json<SessionJSON>(await api("POST", `/v1/sessions/${first.sessionId}/verify`));
    expect(verified.factor_verification_age![0]).toBe(0);
    expect(verified.factor_verification_age![1]).toBe(-1);

    const revoked = await json<SessionJSON>(await api("POST", `/v1/sessions/${second.sessionId}/revoke`));
    expect(revoked.status).toBe("revoked");
    expect((await ctx.db.select().from(s.sessions))).toHaveLength(3);
  });

  it("mints session tokens and validates the template", async () => {
    const { api, ctx } = await testApp();
    const user = await createUser(api);
    const { sessionId } = await createSessionFixture(ctx, user.id);
    await api("POST", "/v1/jwt_templates", { name: "with-email", claims: { email: "{{user.primary_email_address}}" } });

    const plain = await json<{ object: string; jwt: string }>(await api("POST", `/v1/sessions/${sessionId}/tokens`));
    expect(plain).toEqual({ object: "token", jwt: `jwt:${sessionId}:default` });

    const templated = await json<{ object: string; jwt: string }>(await api("POST", `/v1/sessions/${sessionId}/tokens/with-email`));
    expect(templated.jwt).toBe(`jwt:${sessionId}:with-email`);
    expect(signSessionToken).toHaveBeenLastCalledWith(ctx, sessionId, { template: "with-email" });

    expect((await api("POST", `/v1/sessions/${sessionId}/tokens/missing`)).status).toBe(404);

    const ended = await createSessionFixture(ctx, user.id, { status: "ended" });
    const inactive = await api("POST", `/v1/sessions/${ended.sessionId}/tokens`);
    expect(inactive.status).toBe(400);
    expect((await json<ErrorBody>(inactive)).errors[0]!.code).toBe("authentication_invalid");
  });

  it("exposes clients by id and by cookie token", async () => {
    const { api, ctx } = await testApp();
    const user = await createUser(api);
    const { clientId, token, sessionId } = await createSessionFixture(ctx, user.id);

    const client = await json<ClientJSON>(await api("GET", `/v1/clients/${clientId}`));
    expect(client.object).toBe("client");
    expect(client.sessions.map((s) => s.id)).toEqual([sessionId]);

    const verified = await json<ClientJSON>(await api("POST", "/v1/clients/verify", { token }));
    expect(verified.id).toBe(clientId);

    expect((await api("POST", "/v1/clients/verify", { token: "nope" })).status).toBe(404);
    expect((await api("GET", "/v1/clients/client_nope")).status).toBe(404);
  });
});
