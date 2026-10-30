import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { z } from "zod";
import { OrbitError, defaultInstanceSettings, instanceSettingsSchema } from "@orbitid/shared";
import { parseBody, parsePagination, validate } from "../src/lib/http";

/**
 * The zod version is an implementation detail, but its validation semantics are not: the API's error codes, the
 * defaults an omitted field receives, and what a form body may contain are part of the contract with the SDKs.
 * These tests pin the behaviour a zod major upgrade must preserve.
 */

const warm = defaultInstanceSettings();

describe("instance settings defaults", () => {
  // Every nested object used to be `.default({})`, and zod 3 parsed the literal so the inner defaults filled in.
  // zod 4's `.default()` stores the literal as-is; `.prefault()` is the equivalent, and losing it would silently
  // ship an instance with `application`, `email`, `security`, … empty.
  it("fills every nested default when the stored settings are an empty object", () => {
    const parsed = instanceSettingsSchema.parse({});
    expect(parsed).toEqual(warm);
    for (const key of ["application", "attributes", "password", "username", "signUp", "restrictions", "mfa", "session",
      "anonymous", "oidcProvider", "organizations", "userSettings", "email", "sms", "security", "branding"] as const) {
      expect(Object.keys(parsed[key] as object).length, `${key} must keep its defaults`).toBeGreaterThan(0);
    }
  });

  it("keeps the per-attribute defaults, including the unused flags", () => {
    expect(warm.attributes.emailAddress).toEqual({
      enabled: true, required: true, usedForFirstFactor: true, usedForSecondFactor: false,
      verifications: ["email_code"], verifyAtSignUp: true,
    });
    expect(warm.attributes.backupCode).toEqual({
      enabled: false, required: false, usedForFirstFactor: false, usedForSecondFactor: true,
      verifications: [], verifyAtSignUp: true,
    });
    expect(warm.application.allowedOrigins).toEqual(["http://localhost:3000", "http://localhost:5173"]);
    expect(warm.organizations.maxCreatedOrganizationsPerUser).toBeNull();
  });

  it("still merges a partial section without dropping its siblings", () => {
    const parsed = instanceSettingsSchema.parse({ email: { from: "OrbitID <no-reply@example.com>" } });
    expect(parsed.email.from).toBe("OrbitID <no-reply@example.com>");
    expect(parsed.email.codeLength).toBe(6);
    expect(parsed.email.provider).toBe("auto");
  });
});

describe("validate", () => {
  const schema = z.object({
    required_text: z.string(),
    flag: z.boolean().default(false),
    count: z.number().int().min(1).max(5).default(1),
    optional_text: z.string().optional(),
    nullable_text: z.string().nullable(),
    tags: z.array(z.string()).max(3).default([]),
  });

  it("applies defaults for omitted fields and keeps them out of the input type", () => {
    const parsed = validate(schema, { required_text: "x", nullable_text: null });
    expect(parsed).toEqual({ required_text: "x", flag: false, count: 1, tags: [], nullable_text: null });
  });

  it("rejects a missing required field as form_param_missing, naming the parameter", () => {
    const error = (() => { try { validate(schema, { nullable_text: null }); } catch (err) { return err as OrbitError; } return null; })();
    expect(error).toBeInstanceOf(OrbitError);
    expect(error!.status).toBe(422);
    expect(error!.code).toBe("form_param_missing");
    expect(error!.meta).toMatchObject({ param_name: "required_text" });
    expect(error!.message).toBe("required_text is missing");
  });

  it("rejects a present but wrong-typed field as form_param_format_invalid", () => {
    const error = (() => { try { validate(schema, { required_text: 42, nullable_text: null }); } catch (err) { return err as OrbitError; } return null; })();
    expect(error!.code).toBe("form_param_format_invalid");
    expect(error!.meta).toMatchObject({ param_name: "required_text" });
  });

  it("treats an explicit null as a wrong type, not a missing field", () => {
    const error = (() => { try { validate(schema, { required_text: null, nullable_text: null }); } catch (err) { return err as OrbitError; } return null; })();
    expect(error!.code).toBe("form_param_format_invalid");
  });

  it("classifies each issue when a body has several", () => {
    const error = (() => {
      try { validate(schema, { count: 9, nullable_text: null }); } catch (err) { return err as OrbitError; } return null;
    })();
    const items = (error as unknown as { items: { code: string; meta?: { param_name?: string } }[] }).items;
    expect(items.map((item) => [item.meta?.param_name, item.code])).toEqual([
      ["required_text", "form_param_missing"],
      ["count", "form_param_format_invalid"],
    ]);
  });

  it("rejects an array over its bound and a non-integer number", () => {
    expect(() => validate(schema, { required_text: "x", nullable_text: null, tags: ["a", "b", "c", "d"] })).toThrow(OrbitError);
    expect(() => validate(schema, { required_text: "x", nullable_text: null, count: 1.5 })).toThrow(OrbitError);
  });
});

describe("pagination defaults", () => {
  it("defaults an empty query to the first page", () => {
    expect(parsePagination({ req: { query: () => ({}) } } as never)).toEqual({ limit: 10, offset: 0 });
  });

  it("coerces query strings and clamps the documented range", () => {
    const parse = (query: Record<string, string>) => parsePagination({ req: { query: () => query } } as never);
    expect(parse({ limit: "25", offset: "50" })).toEqual({ limit: 25, offset: 50, order_by: undefined });
    expect(() => parse({ limit: "0" })).toThrow(OrbitError);
    expect(() => parse({ limit: "501" })).toThrow(OrbitError);
    expect(() => parse({ limit: "abc" })).toThrow(OrbitError);
  });
});

describe("parseBody", () => {
  const bodySchema = z.object({ a: z.string(), flag: z.boolean().default(false) });
  const app = new Hono()
    .onError((err, c) => {
      const orbit = err instanceof OrbitError ? err : null;
      return c.json({ status: orbit?.status ?? 500, code: orbit?.code ?? "unknown" }, 200);
    })
    .post("/", async (c) => c.json(await parseBody(c, bodySchema)));

  const post = (body: string, contentType = "application/json") =>
    app.request("/", { method: "POST", headers: { "content-type": contentType }, body });

  it("applies a default for an omitted JSON field", async () => {
    expect(await (await post(JSON.stringify({ a: "x" }))).json()).toEqual({ a: "x", flag: false });
  });

  it("reports a missing field from a urlencoded body as form_param_missing", async () => {
    const res = await post("flag=true", "application/x-www-form-urlencoded");
    expect(await res.json()).toEqual({ status: 422, code: "form_param_missing" });
  });

  it("reports a non-boolean form value as a format error", async () => {
    const res = await post("a=x&flag=maybe", "application/x-www-form-urlencoded");
    expect(await res.json()).toEqual({ status: 422, code: "form_param_format_invalid" });
  });
});
