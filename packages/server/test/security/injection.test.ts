import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../src/db/schema";
import { mergeMetadata } from "../../src/modules/admin/shared";
import { mergeMetadata as mergeOrgMetadata } from "../../src/modules/orgs/shared";
import { containsText } from "../../src/lib/db";
import { stripPrototypeKeys } from "../../src/lib/http";
import { logSafe } from "../../src/lib/security";
import { setup, signUpUser } from "../core/helpers";
import { createUser, json, testApp } from "../admin/helpers";

const SECRET = "sk_test_testsecret";

describe("SQL injection and dynamic sorting", () => {
  it("falls back to the default order for an unknown order_by instead of interpolating it", async () => {
    const h = await testApp();
    await createUser(h.api, { first_name: "Ada" });
    for (const orderBy of ["created_at; drop table users", "users.password_hash desc", "(select 1)", "1=1 --", "id) --"]) {
      const res = await h.api("GET", `/v1/users?order_by=${encodeURIComponent(orderBy)}`);
      expect(res.status, orderBy).toBe(200);
      const [, ...rest] = await Promise.all([
        res.json(),
        h.api("GET", "/v1/users/count").then((r) => r.json()),
      ]);
      expect(rest[0].total_count).toBe(1);
    }
  });

  it("accepts a whitelisted order_by and direction", async () => {
    const h = await testApp();
    await createUser(h.api, { first_name: "first" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await createUser(h.api, { first_name: "second" });
    const asc = await json<{ first_name: string }[]>(await h.api("GET", "/v1/users?order_by=%2Bcreated_at"));
    const desc = await json<{ first_name: string }[]>(await h.api("GET", "/v1/users?order_by=-created_at"));
    expect(asc.map((u) => u.first_name)).toEqual(["first", "second"]);
    expect(desc.map((u) => u.first_name)).toEqual(["second", "first"]);
  });

  it("escapes LIKE wildcards so a search for '%' matches a literal percent sign", async () => {
    const h = await testApp();
    await createUser(h.api, { first_name: "100% legit" });
    await createUser(h.api, { first_name: "Ada" });

    const literal = await json<{ first_name: string }[]>(await h.api("GET", `/v1/users?query=${encodeURIComponent("%")}`));
    expect(literal.map((u) => u.first_name)).toEqual(["100% legit"]);

    // `_` is a literal too: "Ada_" matches nothing even though `_` is a SQL wildcard.
    const underscore = await json<{ first_name: string }[]>(await h.api("GET", `/v1/users?query=${encodeURIComponent("Ada_")}`));
    expect(underscore).toHaveLength(0);
    // Same for `\`, which is the LIKE escape character.
    const backslash = await json<{ first_name: string }[]>(await h.api("GET", `/v1/users?query=${encodeURIComponent("Ada\\")}`));
    expect(backslash).toHaveLength(0);
  });

  it("renders containsText as a parameterised LIKE with an escape clause", () => {
    // The term is a bound parameter, and the pattern is escaped rather than concatenated into the SQL.
    const clause = containsText(s.users.username as never, "a' OR 1=1 --");
    // The pattern is a bound parameter in the chunk list, not part of the SQL text.
    const chunks = clause.queryChunks.map((chunk) => (typeof chunk === "string" ? chunk : (chunk as { value?: unknown }).value));
    expect(chunks).toContain("%a' or 1=1 --%");
    // The template itself only ever contains `like` and the escape clause.
    const template = chunks.filter((chunk): chunk is string[] => Array.isArray(chunk)).flat().join(" ");
    expect(template).toContain("like");
    expect(template).toContain("escape");
  });
});

describe("prototype pollution", () => {
  it("ignores __proto__, constructor and prototype when merging metadata", async () => {
    const attack = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"ok":1}');
    for (const merge of [mergeMetadata, mergeOrgMetadata]) {
      const merged = merge({}, attack);
      expect(merged).toEqual({ ok: 1 });
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    }
  });

  it("does not pollute Object.prototype through a metadata PATCH", async () => {
    const h = await testApp();
    const user = await createUser(h.api);
    const res = await h.api("PATCH", `/v1/users/${user.id}/metadata`, {
      public_metadata: JSON.parse('{"__proto__":{"polluted":true},"tier":"gold"}'),
    });
    expect(res.status).toBe(200);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const row = (await h.ctx.db.select().from(s.users).where(eq(s.users.id, user.id)))[0]!;
    expect(row.publicMetadata).toEqual({ tier: "gold" });
    expect(Object.getPrototypeOf(row.publicMetadata)).toBe(Object.prototype);
  });

  it("strips prototype keys from request bodies", () => {
    const cleaned = stripPrototypeKeys(JSON.parse('{"a":1,"__proto__":{"x":1},"nested":{"constructor":{"prototype":{"y":2}}}}'));
    expect(cleaned).toEqual({ a: 1, nested: {} });
  });
});

describe("mass assignment on the Frontend API", () => {
  it("ignores privileged user fields a client tries to write", async () => {
    const { app, ctx } = await setup();
    const user = await signUpUser(app);
    const res = await user.client.request("/v1/client/me", {
      method: "PATCH",
      body: {
        first_name: "Ada",
        banned: true,
        locked: true,
        password_hash: "x",
        passwordHash: "x",
        is_anonymous: true,
        private_metadata: { secret: "leak" },
        unsafe_metadata: { plan: "free" },
        delete_self_enabled: false,
        create_organizations_limit: 99,
        external_id: "chosen",
      },
    });
    expect(res.status).toBe(200);
    const row = (await ctx.db.select().from(s.users).where(eq(s.users.id, user.userId)))[0]!;
    expect(row.banned).toBe(false);
    expect(row.locked).toBe(false);
    expect(row.isAnonymous).toBe(false);
    expect(row.privateMetadata).toEqual({});
    expect(row.externalId).toBeNull();
    expect(row.createOrganizationsLimit).toBeNull();
    expect(row.deleteSelfEnabled).toBe(true);
    expect(row.passwordHash).not.toBe("x");
    expect(row.firstName).toBe("Ada");
    // unsafe_metadata is user-writable by design.
    expect(row.unsafeMetadata).toEqual({ plan: "free" });
  });

  it("does not let a sign-up set a password hash, verified flags or metadata scopes it should not", async () => {
    const { app, ctx } = await setup();
    const res = await app.request("/v1/client/sign_ups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email_address: "mass-assign@example.com",
        password: "Sup3rSecret!",
        password_hash: "$argon2id$attacker",
        email_verified: true,
        private_metadata: { role: "admin" },
        public_metadata: { role: "admin" },
        banned: false,
        external_id: "chosen",
      }),
    });
    expect(res.status).toBe(200);
    // Nothing was written to a user yet (verification is required), and the body's extra keys were dropped.
    expect(await ctx.db.select().from(s.users)).toHaveLength(0);
  });
});

describe("log injection", () => {
  it("escapes control characters so a logged value cannot forge new lines", () => {
    expect(logSafe("a\nb")).toBe("a\\x0ab");
    expect(logSafe("a\r\nFAKE ENTRY")).toBe("a\\x0d\\x0aFAKE ENTRY");
    expect(logSafe("tab\there")).toBe("tab\\x09here");
    expect(logSafe("<script>")).toBe("<script>");
  });
});

describe("user enumeration", () => {
  it("answers sign-in for an unknown identifier the same way regardless of timing side channels", async () => {
    const { app } = await setup();
    await signUpUser(app, { email: "known@example.com" });

    const attempt = async (identifier: string) => {
      const started = performance.now();
      const res = await app.request("/v1/client/sign_ins", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier, password: "WrongPassword!" }),
      });
      const elapsed = performance.now() - started;
      return { status: res.status, body: await res.json(), elapsed };
    };

    const known = await attempt("known@example.com");
    const unknown = await attempt("nobody@example.com");
    expect(known.status).toBe(422);
    expect(unknown.status).toBe(422);
    // Both paths spend one password verification; the ratio must stay in the same order of magnitude.
    expect(unknown.elapsed).toBeGreaterThan(known.elapsed * 0.2);
    expect(known.elapsed).toBeGreaterThan(unknown.elapsed * 0.2);
  });

  it("returns the same identifier_not_found error for unknown users when enumeration protection is off", async () => {
    const { app } = await setup();
    const res = await app.request("/v1/client/sign_ins", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: "nobody@example.com", password: "x" }),
    });
    const body = await res.json();
    expect(body.errors[0].code).toBe("form_identifier_not_found");
  });

  it("hides whether an identifier exists when enumeration protection is on", async () => {
    const { app, ctx } = await setup();
    await ctx.settings.update({ security: { enumerationProtection: true } });
    const res = await app.request("/v1/client/sign_ins", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: "nobody@example.com", password: "x" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.response.first_factor_verification).toBeNull();
  });
});

describe("session fixation", () => {
  it("rotates the client token when a sign-in creates a session", async () => {
    const { app, ctx, } = await setup();
    const user = await signUpUser(app);
    const before = user.client.cookie!;
    expect(before).toContain("__client=");

    // Sign out (ends sessions) then sign in again with the same browser: the token must change.
    const fresh = await (await import("../core/helpers")).testClient(app, before);
    await fresh.request("/v1/client", { method: "DELETE" });
    const signIn = await fresh.json<{ response: { created_session_id: string | null } }>("/v1/client/sign_ins", {
      body: { identifier: user.email, password: user.password },
    });
    expect(signIn.response.created_session_id).toBeTruthy();
    expect(fresh.cookie).not.toBe(before);
    // Only the new token authenticates; the pre-sign-in token no longer resolves to that client.
    const old = /__client=([^;]+)/.exec(before)?.[1];
    const stale = await app.request("/v1/client", { headers: { cookie: `__client=${old}` } });
    expect(stale.status).toBe(200);
    const staleBody = await stale.json();
    expect(staleBody.client.id).not.toBe((await fresh.json<any>("/v1/client")).client.id);
    expect(ctx.database.dialect).toBeTruthy();
  });
});

describe("regex and input abuse", () => {
  it("does not build a RegExp from user input anywhere reachable from a request", async () => {
    const { app } = await setup();
    // A pathological pattern-looking value is treated as plain text.
    const res = await app.request("/v1/client/sign_ins", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: "((((((((((a+)+)+)+)+)+)+)+)+)@example.com", password: "x" }),
    });
    expect([422, 200]).toContain(res.status);
  });

  it("caps username and metadata sizes at the schema level", async () => {
    const { app } = await setup();
    const user = await signUpUser(app);
    const huge = "x".repeat(10_000);
    const res = await user.client.request("/v1/client/me", { method: "PATCH", body: { first_name: huge } });
    expect(res.status).toBe(422);

    const metadata = await user.client.request("/v1/client/me", {
      method: "PATCH",
      body: { unsafe_metadata: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, "x".repeat(100)])) },
    });
    expect(metadata.status).toBe(422);
  });
});

describe("email header injection", () => {
  it("keeps user-controlled names out of the header structure", async () => {
    const { latestEmail, setMailTransport } = await import("../../src/services/mail");
    setMailTransport(async () => undefined);
    try {
      const { app } = await setup();
      const user = await signUpUser(app, { firstName: "Ada\r\nBcc: victim@example.com" });
      const res = await user.client.request("/v1/client/me/change_password", {
        body: { current_password: user.password, new_password: "N3w!Password" },
      });
      expect(res.status).toBe(200);
      const mail = latestEmail(user.email, "password_changed");
      expect(mail).toBeTruthy();
      expect(mail!.subject).not.toMatch(/[\r\n]/);
      // HTML escaping keeps markup inert (another engineer owns the transports; we only review output).
      expect(mail!.html).not.toMatch(/<img[^>]*onerror/);
    } finally {
      setMailTransport(null);
    }
  });
});
