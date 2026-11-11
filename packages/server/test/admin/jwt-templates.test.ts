import { describe, it, expect } from "vitest";
import { ErrorCodes, ID_PREFIX, type JwtTemplateJSON, type PaginatedList } from "@orbitid/shared";
import { eq } from "drizzle-orm";
import * as s from "../../src/db/schema";
import { newId } from "../../src/lib/ids";
import {
  buildShortcodeContext, renderClaimsWithContext, renderTemplateClaims, renderTemplateValue,
} from "../../src/services/jwt-templates";
import { signSessionToken, verifySessionToken } from "../../src/services/tokens";
import { createSessionFixture, createUser, json, testApp, type ErrorBody } from "./helpers";
import { first } from "../../src/lib/db";

describe("jwt template shortcodes", () => {
  const context = {
    user: {
      id: "user_1",
      username: "ada",
      first_name: "Ada",
      last_name: "Lovelace",
      full_name: "Ada Lovelace",
      primary_email_address: "ada@example.com",
      email_verified: true,
      created_at: 1_700_000_000_000,
      public_metadata: { tier: "pro", team: { name: "core", size: 3 }, tags: ["a", "b"] },
      unsafe_metadata: {},
    },
    session: { id: "sess_1" },
    org: { id: "org_1", slug: "acme", role: "org:admin", permissions: ["org:sys_profile:manage"] },
    org_membership: { role: "org:admin", permissions: ["org:sys_profile:manage"] },
  };

  it("keeps the JSON type when a claim is a single shortcode", () => {
    expect(renderTemplateValue("{{user.created_at}}", context)).toBe(1_700_000_000_000);
    expect(renderTemplateValue("{{user.email_verified}}", context)).toBe(true);
    expect(renderTemplateValue("{{user.public_metadata}}", context)).toEqual({ tier: "pro", team: { name: "core", size: 3 }, tags: ["a", "b"] });
    expect(renderTemplateValue("{{user.public_metadata.tags}}", context)).toEqual(["a", "b"]);
    expect(renderTemplateValue("  {{user.id}}  ", context)).toBe("user_1");
  });

  it("interpolates strings and renders missing values as empty", () => {
    expect(renderTemplateValue("{{user.first_name}} <{{user.primary_email_address}}>", context)).toBe("Ada <ada@example.com>");
    expect(renderTemplateValue("hi {{user.nope}}!", context)).toBe("hi !");
    expect(renderTemplateValue("no shortcodes", context)).toBe("no shortcodes");
    expect(renderTemplateValue("meta={{user.public_metadata.team}}", context)).toBe('meta={"name":"core","size":3}');
  });

  it("resolves || fallbacks, including quoted literals", () => {
    expect(renderTemplateValue("{{user.nope || user.username}}", context)).toBe("ada");
    expect(renderTemplateValue("{{user.nope || user.also_nope || 'there'}}", context)).toBe("there");
    expect(renderTemplateValue("{{user.email_verified || false}}", context)).toBe(true);
    expect(renderTemplateValue("{{user.nope || 'a||b'}}", context)).toBe("a||b");
    expect(renderTemplateValue("{{user.nope}}", context)).toBeUndefined();
  });

  it("drops claims that resolve to nothing and walks nested claim objects", () => {
    expect(renderClaimsWithContext({ a: "{{user.nope}}", b: "{{user.id}}", c: 5, d: { e: "{{user.nope}}", f: "{{user.username}}" } }, context)).toEqual({
      b: "user_1",
      c: 5,
      d: { f: "ada" },
    });
    expect(renderClaimsWithContext({ list: ["{{user.nope}}", "{{user.id}}"] }, context)).toEqual({ list: ["user_1"] });
  });

  it("builds the shortcode context from the database and renders a stored template", async () => {
    const { api, ctx } = await testApp();
    const user = await createUser(api, {
      email_address: ["ada@example.com"],
      first_name: "Ada",
      last_name: "Lovelace",
      username: "ada",
      public_metadata: { tier: "pro", team: { name: "core" } },
    });
    const orgId = newId("org");
    await ctx.db.insert(s.organizations).values({ id: orgId, name: "Acme", slug: "acme", publicMetadata: { plan: "enterprise" } });
    await ctx.db.insert(s.organizationMemberships).values({ id: newId(ID_PREFIX.membership), organizationId: orgId, userId: user.id, roleKey: "org:member" });
    const { sessionId } = await createSessionFixture(ctx, user.id);
    await ctx.db.update(s.sessions).set({ lastActiveOrganizationId: orgId }).where(eq(s.sessions.id, sessionId));

    const shortcodes = await buildShortcodeContext(ctx, { userId: user.id, sessionId });
    expect(shortcodes.user).toMatchObject({ id: user.id, full_name: "Ada Lovelace", primary_email_address: "ada@example.com", email_verified: true });
    expect(shortcodes.org).toMatchObject({ slug: "acme", role: "org:member" });
    expect(shortcodes.session).toMatchObject({ id: sessionId });

    await api("POST", "/v1/jwt_templates", {
      name: "claims",
      claims: {
        email: "{{user.primary_email_address}}",
        name: "{{user.full_name || user.username}}",
        org: "{{org.slug}}",
        tier: "{{user.public_metadata.tier}}",
        nested: "{{user.public_metadata.team.name}}",
        perms: "{{org_membership.permissions}}",
        missing: "{{user.nope}}",
        latin: "{{user.last_name}}",
      },
      lifetime: 120,
      allowed_clock_skew: 10,
    });

    const rendered = await renderTemplateClaims(ctx, "claims", { userId: user.id, sessionId });
    expect(rendered).toMatchObject({ lifetimeSeconds: 120, allowedClockSkewSeconds: 10, algorithm: "RS256", signingKeyEnc: null });
    expect(rendered!.claims).toEqual({
      email: "ada@example.com",
      name: "Ada Lovelace",
      org: "acme",
      tier: "pro",
      nested: "core",
      perms: expect.arrayContaining(["org:sys_memberships:read"]),
      latin: "Lovelace",
    });

    expect(await renderTemplateClaims(ctx, "missing", { userId: user.id })).toBeNull();
  });
});

describe("jwt template tokens", () => {
  it("are marked and refused as sessions, but can be verified deliberately", async () => {
    const { api, app, ctx } = await testApp();
    const user = await createUser(api);
    const { sessionId } = await createSessionFixture(ctx, user.id);
    await api("POST", "/v1/jwt_templates", { name: "long-lived", claims: { plan: "pro" }, lifetime: 315_360_000 });

    const templateJwt = await signSessionToken(ctx, sessionId, { template: "long-lived" });
    const payload = JSON.parse(Buffer.from(templateJwt.split(".")[1]!, "base64url").toString()) as Record<string, unknown>;
    expect(payload.token_type).toBe("jwt_template");
    expect(payload.plan).toBe("pro");
    expect(Number(payload.exp) - Number(payload.iat)).toBe(315_360_000);

    await expect(verifySessionToken(ctx, templateJwt)).rejects.toMatchObject({ code: ErrorCodes.authentication_invalid });
    await expect(verifySessionToken(ctx, templateJwt, { tokenType: "jwt_template" })).resolves.toMatchObject({ sub: user.id, sid: sessionId });

    // Ordinary session tokens are still accepted.
    const sessionJwt = await signSessionToken(ctx, sessionId);
    await expect(verifySessionToken(ctx, sessionJwt)).resolves.toMatchObject({ sub: user.id, sid: sessionId });

    // The Frontend API's bearer-session routes use the same verifier: a template token is not a session there either.
    await ctx.settings.update({ organizations: { enabled: true } });
    const res = await app.request("/v1/client/organizations", {
      method: "POST",
      headers: { authorization: `Bearer ${templateJwt}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Acme" }),
    });
    expect(res.status).toBe(401);
    expect(await ctx.db.select().from(s.organizations)).toHaveLength(0);
  });
});

describe("jwt template CRUD", () => {
  it("creates, lists, updates and deletes templates", async () => {
    const { api, ctx } = await testApp();
    const created = await json<JwtTemplateJSON>(
      await api("POST", "/v1/jwt_templates", { name: "hasura", claims: { "https://hasura.io/jwt/claims": { "x-hasura-user-id": "{{user.id}}" } } }),
    );
    expect(created).toMatchObject({ object: "jwt_template", name: "hasura", lifetime: 60, allowed_clock_skew: 5, custom_signing_key: false, signing_algorithm: "RS256" });
    expect((await ctx.db.select().from(s.jwtTemplates))[0]!.signingKeyEnc).toBeNull();

    expect((await api("POST", "/v1/jwt_templates", { name: "hasura" })).status).toBe(422);
    expect((await json<PaginatedList<JwtTemplateJSON>>(await api("GET", "/v1/jwt_templates"))).total_count).toBe(1);
    expect((await json<JwtTemplateJSON>(await api("GET", `/v1/jwt_templates/${created.id}`))).name).toBe("hasura");

    const updated = await json<JwtTemplateJSON>(await api("PATCH", `/v1/jwt_templates/${created.id}`, { lifetime: 300, claims: { sub2: "{{user.username}}" } }));
    expect(updated.lifetime).toBe(300);
    expect(updated.claims).toEqual({ sub2: "{{user.username}}" });

    expect(await json(await api("DELETE", `/v1/jwt_templates/${created.id}`))).toEqual({ object: "jwt_template", id: created.id, deleted: true });
    expect((await api("GET", `/v1/jwt_templates/${created.id}`)).status).toBe(404);
  });

  it("rejects reserved claims and out-of-range options", async () => {
    const { api } = await testApp();
    // `roles` / `role_permissions` are the instance-role claims: a template must not be able to grant one.
    for (const claim of ["sub", "iss", "exp", "azp", "sid", "act", "org_id", "org_role", "org_permissions", "roles", "role_permissions", "fva", "sts", "anonymous", "token_type"]) {
      const res = await api("POST", "/v1/jwt_templates", { name: `t-${claim}`, claims: { [claim]: "x" } });
      expect(res.status).toBe(422);
      expect((await json<ErrorBody>(res)).errors[0]!.code).toBe("form_param_value_invalid");
    }
    expect((await api("POST", "/v1/jwt_templates", { name: "short", lifetime: 10 })).status).toBe(422);
    expect((await api("POST", "/v1/jwt_templates", { name: "long", lifetime: 315_360_001 })).status).toBe(422);
    expect((await api("POST", "/v1/jwt_templates", { name: "skew", allowed_clock_skew: 301 })).status).toBe(422);
    expect((await api("POST", "/v1/jwt_templates", { name: "bad name!" })).status).toBe(422);
    expect((await api("POST", "/v1/jwt_templates", { name: "vectors", claims: [] })).status).toBe(422);
  });

  it("changes only the fields a PATCH sends", async () => {
    const { api } = await testApp();
    const created = await json<JwtTemplateJSON>(await api("POST", "/v1/jwt_templates", {
      name: "keep-options",
      claims: { plan: "pro" },
      lifetime: 120,
      allowed_clock_skew: 30,
      custom_signing_key: true,
    }));
    const updated = await json<JwtTemplateJSON>(await api("PATCH", `/v1/jwt_templates/${created.id}`, { name: "renamed" }));
    expect(updated).toMatchObject({
      name: "renamed",
      claims: { plan: "pro" },
      lifetime: 120,
      allowed_clock_skew: 30,
      custom_signing_key: true,
      signing_algorithm: "RS256",
    });

    // Changing the algorithm under a custom key rotates that key instead of turning custom signing off.
    const rotated = await json<JwtTemplateJSON>(await api("PATCH", `/v1/jwt_templates/${created.id}`, { signing_algorithm: "HS256" }));
    expect(rotated.custom_signing_key).toBe(true);
    expect(rotated.signing_algorithm).toBe("HS256");
    expect(typeof rotated.signing_key).toBe("string");
  });

  it("generates and rotates custom signing keys", async () => {
    const { api, ctx } = await testApp();
    const rs = await json<JwtTemplateJSON>(await api("POST", "/v1/jwt_templates", { name: "custom-rs", claims: { a: "{{user.id}}" }, custom_signing_key: true }));
    expect(rs.custom_signing_key).toBe(true);
    const row = first(await ctx.db.select().from(s.jwtTemplates).where(eq(s.jwtTemplates.id, rs.id)))!;
    expect(row.signingKeyEnc).toMatch(/^v1\./);
    expect(row.signingKeyEnc).not.toContain('"kty"');

    const es = await json<JwtTemplateJSON>(await api("POST", "/v1/jwt_templates", { name: "custom-es", custom_signing_key: true, signing_algorithm: "ES256" }));
    const esRow = first(await ctx.db.select().from(s.jwtTemplates).where(eq(s.jwtTemplates.id, es.id)))!;
    expect(esRow.signingAlgorithm).toBe("ES256");
    expect(esRow.signingKeyEnc).toMatch(/^v1\./);

    const rotated = await json<JwtTemplateJSON>(await api("PATCH", `/v1/jwt_templates/${rs.id}`, { signing_algorithm: "HS256" }));
    expect(rotated.signing_algorithm).toBe("HS256");
    expect(first(await ctx.db.select().from(s.jwtTemplates).where(eq(s.jwtTemplates.id, rs.id)))!.signingKeyEnc).not.toBe(row.signingKeyEnc);

    const cleared = await json<JwtTemplateJSON>(await api("PATCH", `/v1/jwt_templates/${rs.id}`, { custom_signing_key: false }));
    expect(cleared.custom_signing_key).toBe(false);
    expect(first(await ctx.db.select().from(s.jwtTemplates).where(eq(s.jwtTemplates.id, rs.id)))!.signingKeyEnc).toBeNull();
  });
});
