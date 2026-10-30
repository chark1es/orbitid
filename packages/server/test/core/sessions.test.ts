import { describe, expect, it } from "vitest";
import { createLocalJWKSet, jwtVerify, type JWK } from "jose";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { latestCodeFor } from "../../src/services/mail";
import { sha256 } from "../../src/lib/crypto";
import { rotateSigningKey, signJwt, signSessionToken, verifySessionToken } from "../../src/services/tokens";
import { errorsOf, getClient, setup, signUpUser, testClient } from "./helpers";

describe("sessions & tokens", () => {
  it("mints RS256 session tokens that verify against the published JWKS", async () => {
    const { app, ctx } = await setup();
    const user = await signUpUser(app);
    const state = await getClient(user.client);
    const session = state.response.sessions[0]!;
    expect(session.last_active_token).not.toBeNull();

    const jwksRes = await app.request("/.well-known/jwks.json");
    expect(jwksRes.status).toBe(200);
    // JSON boundary: the endpoint returns a JWKS document.
    const jwks = (await jwksRes.json()) as { keys: JWK[] };
    expect(jwks.keys.length).toBeGreaterThan(0);
    expect(jwks.keys[0]!.kid).toBeTruthy();
    expect(jwks.keys[0]).not.toHaveProperty("d");
    const alias = await app.request("/v1/jwks");
    expect(await alias.json()).toEqual(jwks);

    const { payload, protectedHeader } = await jwtVerify(session.last_active_token!.jwt, createLocalJWKSet(jwks), { issuer: ctx.env.baseUrl });
    expect(protectedHeader.alg).toBe("RS256");
    expect(payload.sub).toBe(user.userId);
    expect(payload.sid).toBe(session.id);
    expect(payload.sts).toBe("active");
    expect(payload.fva).toEqual([0, -1]);
    expect(payload.exp! - payload.iat!).toBe(60);
  });

  it("uses JWT templates and custom session claims", async () => {
    const { app, ctx } = await setup();
    const user = await signUpUser(app);
    await ctx.db.insert(schema.jwtTemplates).values({
                  id: "jtmpl_custom", name: "custom", claims: { email: "{{user.primary_email_address}}", orgs: "{{org.slug || 'none'}}" },
                  lifetime: 120, allowedClockSkew: 5, createdAt: Date.now(), updatedAt: Date.now(),
                });

    const templated = await user.client.json<{ jwt: string }>(`/v1/client/sessions/${user.sessionId}/tokens/custom`, { method: "POST", body: {} });
    const jwks = (await (await app.request("/.well-known/jwks.json")).json()) as { keys: JWK[] };
    const { payload } = await jwtVerify(templated.jwt, createLocalJWKSet(jwks), { issuer: ctx.env.baseUrl });
    expect(payload.email).toBe(user.email);
    expect(payload.orgs).toBe("none");
    expect(payload.exp! - payload.iat!).toBe(120);

    await ctx.settings.update({ session: { customClaims: { plan: "pro", email: "{{user.primary_email_address}}" } } });
    const custom = await user.client.json<{ jwt: string }>(`/v1/client/sessions/${user.sessionId}/tokens`, { method: "POST", body: {} });
    const decoded = await jwtVerify(custom.jwt, createLocalJWKSet(jwks), { issuer: ctx.env.baseUrl });
    expect(decoded.payload.plan).toBe("pro");
    expect(decoded.payload.email).toBe(user.email);
  });

  it("never lets configured custom claims grant an instance role", async () => {
    // `roles` / `role_permissions` are reserved: an operator's convenience claim must not become an escalation
    // path into an authorization decision.
    const { app, ctx } = await setup();
    await ctx.settings.update({ session: { customClaims: { roles: ["app:admin"], role_permissions: ["*"], plan: "pro" } } });
    const user = await signUpUser(app);
    const minted = await user.client.json<{ jwt: string }>(`/v1/client/sessions/${user.sessionId}/tokens`, { method: "POST", body: {} });
    const jwks = (await (await app.request("/.well-known/jwks.json")).json()) as { keys: JWK[] };
    const { payload } = await jwtVerify(minted.jwt, createLocalJWKSet(jwks), { issuer: ctx.env.baseUrl });
    expect(payload.roles).toEqual([]);
    expect(payload.role_permissions).toEqual([]);
    expect(payload.plan).toBe("pro");
  });

  it("keeps verifying old tokens after key rotation and signs new ones with the new key", async () => {
    const { app, ctx } = await setup();
    const user = await signUpUser(app);
    const before = await getClient(user.client);
    const oldJwt = before.response.sessions[0]!.last_active_token!.jwt;

    const rotated = await rotateSigningKey(ctx);
    const jwks = (await (await app.request("/.well-known/jwks.json")).json()) as { keys: JWK[] };
    expect(jwks.keys.some((k) => k.kid === rotated.kid)).toBe(true);
    expect(jwks.keys.length).toBeGreaterThanOrEqual(2);
    await expect(jwtVerify(oldJwt, createLocalJWKSet(jwks), { issuer: ctx.env.baseUrl })).resolves.toBeTruthy();

    const minted = await user.client.json<{ jwt: string }>(`/v1/client/sessions/${user.sessionId}/tokens`, { method: "POST", body: {} });
    const verified = await jwtVerify(minted.jwt, createLocalJWKSet(jwks), { issuer: ctx.env.baseUrl });
    expect(verified.protectedHeader.kid).toBe(rotated.kid);
  });

  it("accepts urlencoded bodies on the Frontend API", async () => {
    const { app } = await setup();
    const user = await signUpUser(app);
    const res = await app.request("/v1/client/sign_ins", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ identifier: user.email, password: user.password }).toString(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { response: { status: string } };
    expect(body.response.status).toBe("complete");
  });

  it("refuses operator-minted sign-in and actor tickets instead of creating a session", async () => {
    // Impersonation was removed. A row that exists in the database must not become somebody else's session.
    const { app, ctx } = await setup();
    const user = await signUpUser(app);
    const now = Date.now();
    await ctx.db.insert(schema.signInTokens).values({
                  id: "sit_test", userId: user.userId, tokenHash: sha256("sit-ticket"), status: "pending", expiresAt: now + 60_000, createdAt: now, updatedAt: now,
                });
    await ctx.db.insert(schema.actorTokens).values({
                  id: "act_test", userId: user.userId, actor: { sub: "admin_42" }, tokenHash: sha256("actor-ticket"), status: "pending",
                  expiresAt: now + 60_000, sessionMaxDurationSeconds: 600, createdAt: now, updatedAt: now,
                });
    const sessionsBefore = (await ctx.db.select().from(schema.sessions)).length;
    for (const ticket of ["sit-ticket", "actor-ticket"]) {
      const client = testClient(app);
      const res = await client.request("/v1/client/sign_ins", { body: { ticket } });
      expect(res.status, ticket).toBe(422);
      expect(((await res.json()) as { errors: { code: string }[] }).errors[0]!.code).toBe("ticket_invalid");
      const state = await getClient(client);
      expect(state.response.sessions).toHaveLength(0);
    }
    // The sign-up already made one session; no ticket added another.
    expect((await ctx.db.select().from(schema.sessions)).length).toBe(sessionsBefore);
  });

  it("authenticates the client from an Authorization bearer token", async () => {
    const { app } = await setup();
    const user = await signUpUser(app);
    const state = await getClient(user.client);
    const token = user.client.cookie?.replace(/^__client=/, "");
    expect(token).toBeTruthy();
    const res = await app.request("/v1/client", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { response: { id: string } };
    expect(body.response.id).toBe(state.response.id);
  });

  it("includes organization claims for the session's active organization", async () => {
    const { app, ctx } = await setup();
    await ctx.settings.update({ organizations: { enabled: true } });
    const user = await signUpUser(app);
    const now = Date.now();
    await ctx.db.insert(schema.organizations).values({ id: "org_claims", name: "Claims Inc", slug: "claims-inc", createdAt: now, updatedAt: now });
    await ctx.db.insert(schema.organizationMemberships).values({
                  id: "orgmem_claims", organizationId: "org_claims", userId: user.userId, roleKey: "org:admin", createdAt: now, updatedAt: now,
                });

    await user.client.json(`/v1/client/sessions/${user.sessionId}/touch`, { body: { active_organization_id: "org_claims" } });
    const minted = await user.client.json<{ jwt: string }>(`/v1/client/sessions/${user.sessionId}/tokens`, { method: "POST", body: {} });
    const jwks = (await (await app.request("/.well-known/jwks.json")).json()) as { keys: JWK[] };
    const { payload } = await jwtVerify(minted.jwt, createLocalJWKSet(jwks), { issuer: ctx.env.baseUrl });
    expect(payload.org_id).toBe("org_claims");
    expect(payload.org_slug).toBe("claims-inc");
    expect(payload.org_role).toBe("org:admin");
    expect(payload.org_permissions).toContain("org:sys_profile:manage");

    const foreignOrg = await user.client.json(`/v1/client/sessions/${user.sessionId}/touch`, { body: { active_organization_id: "org_other" } });
    expect(errorsOf(foreignOrg)[0]?.code).toBe("not_a_member_in_organization");

    // an explicit null switches back to the personal account and drops the org claims
    await user.client.json(`/v1/client/sessions/${user.sessionId}/touch`, { body: { active_organization_id: null } });
    const personal = await user.client.json<{ jwt: string }>(`/v1/client/sessions/${user.sessionId}/tokens`, { method: "POST", body: {} });
    const { payload: personalClaims } = await jwtVerify(personal.jwt, createLocalJWKSet(jwks), { issuer: ctx.env.baseUrl });
    expect(personalClaims.org_id).toBeUndefined();
  });

  it("does not accept a token with an audience as a session token", async () => {
    const { app, ctx } = await setup();
    const user = await signUpUser(app);
    const forged = await signJwt(ctx, { sub: user.userId, sid: user.sessionId }, { expiresInSeconds: 60, audience: "orbitid-m2m", issuer: ctx.env.baseUrl });
    await expect(verifySessionToken(ctx, forged)).rejects.toThrow("Invalid session token");
    const genuine = await signSessionToken(ctx, user.sessionId);
    await expect(verifySessionToken(ctx, genuine)).resolves.toMatchObject({ sid: user.sessionId });
  });

  it("touches, ends and removes sessions", async () => {
    const { app, ctx } = await setup();
    const user = await signUpUser(app);
    const sessionId = user.sessionId;
    await ctx.db.update(schema.sessions).set({ lastActiveAt: Date.now() - 120_000 }).where(eq(schema.sessions.id, sessionId));

    const touched = await user.client.json<{ response: { last_active_at: number } }>(`/v1/client/sessions/${sessionId}/touch`, { body: {} });
    expect(touched.response.last_active_at).toBeGreaterThan(Date.now() - 5_000);

    const ended = await user.client.json<{ response: { status: string }; client: { last_active_session_id: string | null } }>(`/v1/client/sessions/${sessionId}/end`, { body: {} });
    expect(ended.response.status).toBe("ended");
    expect(ended.client.last_active_session_id).toBeNull();

    const blocked = await user.client.json(`/v1/client/sessions/${sessionId}/tokens`, { method: "POST" });
    expect(errorsOf(blocked)[0]?.code).toBe("authentication_invalid");
  });

  it("supports multiple sessions per client when multi-session mode is on", async () => {
    const { app, ctx } = await setup();
    await ctx.settings.update({ session: { multiSession: true } });
    const user = await signUpUser(app);
    const first = await user.client.json<{ response: { created_session_id: string } }>("/v1/client/sign_ins", {
      body: { identifier: user.email, password: user.password },
    });
    const state = await getClient(user.client);
    expect(state.response.sessions.filter((s) => s.status === "active")).toHaveLength(2);
    expect(state.response.last_active_session_id).toBe(first.response.created_session_id);
    for (const session of state.response.sessions) {
      expect(session.last_active_token?.jwt).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    }
  });

  it("refuses a second session in single-session mode", async () => {
    const { app } = await setup();
    const user = await signUpUser(app);
    const res = await user.client.json("/v1/client/sign_ins", { body: { identifier: user.email, password: user.password } });
    expect(errorsOf(res)[0]?.code).toBe("identifier_already_signed_in");
  });

  it("revokes every session on DELETE /v1/client", async () => {
    const { app } = await setup();
    const user = await signUpUser(app);
    const deleted = await user.client.json<{ response: { sessions: { status: string }[] } }>("/v1/client", { method: "DELETE" });
    expect(deleted.response.sessions.some((s) => s.status === "active")).toBe(false);
    const me = await user.client.json("/v1/client/me");
    expect(errorsOf(me)[0]?.code).toBe("authentication_invalid");
  });

  it("enforces reverification for sensitive mutations and clears it after a code", async () => {
    const { app, ctx } = await setup();
    const user = await signUpUser(app);
    const sessionId = user.sessionId;
    await ctx.db.update(schema.sessions).set({ firstFactorVerifiedAt: Date.now() - 60 * 60_000 }).where(eq(schema.sessions.id, sessionId));

    const denied = await user.client.json("/v1/client/me/email_addresses", { body: { email_address: "second@example.com" } });
    const error = errorsOf(denied)[0]!;
    expect(error.code).toBe("session_reverification_required");
    expect(error.meta).toMatchObject({ level: "first_factor", after_minutes: 10, session_id: sessionId });

    await user.client.json(`/v1/client/sessions/${sessionId}/verify/prepare_first_factor`, { body: { strategy: "email_code" } });
    const code = latestCodeFor(user.email)!;
    const verified = await user.client.json<{ response: { status: string; strategy: string } }>(`/v1/client/sessions/${sessionId}/verify/attempt_first_factor`, {
      body: { strategy: "email_code", code },
    });
    expect(verified.response.status).toBe("verified");
    expect(verified.response.strategy).toBe("email_code");

    const allowed = await user.client.json<{ response: { email_address: string } }>("/v1/client/me/email_addresses", { body: { email_address: "second@example.com" } });
    expect(allowed.response.email_address).toBe("second@example.com");
  });

  it("expires sessions past their lifetime", async () => {
    const { app, ctx } = await setup();
    const user = await signUpUser(app);
    await ctx.db.update(schema.sessions).set({ expireAt: Date.now() - 1 }).where(eq(schema.sessions.id, user.sessionId));
    const me = await user.client.json("/v1/client/me");
    expect(errorsOf(me)[0]?.code).toBe("authentication_invalid");
    const state = await getClient(user.client);
    expect(state.response.sessions).toHaveLength(0);
  });

  it("enforces the inactivity timeout", async () => {
    const { app, ctx } = await setup();
    await ctx.settings.update({ session: { inactivityTimeoutSeconds: 60 } });
    const user = await signUpUser(app);
    await ctx.db.update(schema.sessions).set({ lastActiveAt: Date.now() - 120_000 }).where(eq(schema.sessions.id, user.sessionId));
    const me = await user.client.json("/v1/client/me");
    expect(errorsOf(me)[0]?.code).toBe("authentication_invalid");
  });
});
