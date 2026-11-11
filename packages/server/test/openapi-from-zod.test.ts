import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fromZod } from "../src/openapi/from-zod";
import { buildOpenApi } from "../src/openapi";

/**
 * The converter turns request schemas into the published JSON Schema. zod 4's `z.toJSONSchema` replaced the hand-rolled
 * walk over `_def`, so these tests pin the parts the document depends on: client-side (`input`) semantics, defaults,
 * optionality and the shapes the server actually uses.
 */

describe("fromZod", () => {
  it("describes a defaulted field as optional with its default", () => {
    const schema = fromZod(z.object({ name: z.string().default("OrbitID App") }));
    expect(schema).toEqual({
      type: "object",
      properties: { name: { type: "string", default: "OrbitID App" } },
    });
    // A defaulted field may be omitted, so it must not be required — otherwise a client that omits it is "invalid"
    // according to the document, while the server happily fills the default in.
    expect(schema.required).toBeUndefined();
  });

  it("keeps an optional field out of `required` and a plain field in it", () => {
    const schema = fromZod(z.object({ a: z.string(), b: z.string().optional(), c: z.string().nullable() }));
    expect(schema.required).toEqual(["a", "c"]);
  });

  it("expresses nullable as a union type rather than OpenAPI 3.0's `nullable`", () => {
    expect(fromZod(z.string().nullable())).toEqual({ type: ["string", "null"] });
    expect(fromZod(z.array(z.string()).nullable())).toEqual({ type: ["array", "null"], items: { type: "string" } });
  });

  it("converts the constraints the API documents", () => {
    expect(fromZod(z.string().min(2).max(8))).toEqual({ type: "string", minLength: 2, maxLength: 8 });
    expect(fromZod(z.string().email())).toMatchObject({ type: "string", format: "email" });
    expect(fromZod(z.string().url())).toMatchObject({ type: "string", format: "uri" });
    expect(fromZod(z.array(z.string()).max(3))).toEqual({ type: "array", items: { type: "string" }, maxItems: 3 });
    expect(fromZod(z.number().int().min(1).max(5))).toEqual({ type: "integer", minimum: 1, maximum: 5 });
    expect(fromZod(z.enum(["a", "b"]))).toEqual({ type: "string", enum: ["a", "b"] });
    expect(fromZod(z.literal("fixed"))).toEqual({ type: "string", const: "fixed" });
  });

  it("does not leak zod's safe-integer bounds into the document", () => {
    // `.int()` is `safeint` in zod, which adds ±Number.MAX_SAFE_INTEGER. Those are an implementation limit, not a
    // contract, and would read as "numbers between -9007199254740991 and 9007199254740991" in the docs.
    const schema = fromZod(z.object({ n: z.number().int() }));
    expect(schema).toMatchObject({ properties: { n: { type: "integer" } } });
    expect((schema.properties as Record<string, Record<string, unknown>>).n).not.toHaveProperty("minimum");
    expect((schema.properties as Record<string, Record<string, unknown>>).n).not.toHaveProperty("maximum");
  });

  it("describes records and open objects", () => {
    expect(fromZod(z.record(z.string(), z.number()))).toMatchObject({ type: "object", additionalProperties: { type: "number" } });
    expect(fromZod(z.object({ sub: z.string() }).passthrough())).toMatchObject({ additionalProperties: {} });
  });

  it("describes preprocessed (form-coerced) values by the schema they produce", () => {
    const boolish = z.preprocess((value) => {
      if (typeof value === "string") return value === "true" || value === "1";
      return value;
    }, z.boolean()).describe("Accepts `true`/`false`.");
    expect(fromZod(z.object({ flag: boolish }))).toMatchObject({
      properties: { flag: { type: "boolean", description: "Accepts `true`/`false`." } },
    });
  });

  it("uses the input side of a default so the documented type is what a client may send", () => {
    // `io: "input"` is why this is `undefined`-accepting; `io: "output"` would document the filled-in value instead.
    const schema = fromZod(z.object({ tags: z.array(z.string()).default([]) }));
    expect(schema).toMatchObject({ properties: { tags: { type: "array", items: { type: "string" }, default: [] } } });
    expect(schema.required).toBeUndefined();
  });

  it("refuses a recursive schema instead of publishing an unresolvable $ref", () => {
    const node: z.ZodType<unknown> = z.lazy(() => z.union([z.string(), z.array(node)]));
    expect(() => fromZod(z.object({ tree: node }))).toThrow(/fromZod:/);
  });

  it("produces a schema without the JSON Schema dialect marker", () => {
    // The OpenAPI document declares its own dialect (`jsonSchemaDialect`); a nested `$schema` would be wrong there.
    expect(JSON.stringify(fromZod(z.object({ a: z.string() })))).not.toContain("$schema");
  });
});

describe("the generated document", () => {
  const spec = buildOpenApi({ baseUrl: "https://auth.example.com" });
  const json = JSON.stringify(spec);

  it("contains no document-local or zod-local references", () => {
    expect(json).not.toContain("#/$defs");
    expect(json).not.toContain("zod");
  });

  it("documents every integer as an integer, not a bounded safeint", () => {
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      if (record.type === "integer") {
        expect(record.minimum).not.toBe(Number.MIN_SAFE_INTEGER);
        expect(record.maximum).not.toBe(Number.MAX_SAFE_INTEGER);
      }
      Object.values(record).forEach(walk);
    };
    walk(spec);
  });

  it("documents request-body defaults from the shared instance settings", () => {
    // `PATCH /v1/instance` takes the settings tree; the document derives it from `instanceSettingsSchema`, so a
    // default that is lost in a zod upgrade would also disappear from the published document.
    const instance = spec.components.schemas.Instance as Record<string, any>;
    expect(instance.properties.password.properties.minLength.default).toBe(8);
    expect(instance.properties.application.properties.homeUrl.default).toBe("http://localhost:3000");
    expect(instance.properties.session.properties.lifetimeSeconds.default).toBe(0);
    expect(instance.properties.branding.properties.theme.default).toBe("system");
  });

  it("keeps defaulted request fields optional in every operation", () => {
    for (const [path, item] of Object.entries(spec.paths as Record<string, Record<string, any>>)) {
      for (const [method, operation] of Object.entries(item)) {
        const schema = operation?.requestBody?.content?.["application/json"]?.schema;
        if (!schema?.properties) continue;
        for (const [name, property] of Object.entries<Record<string, unknown>>(schema.properties)) {
          if (!("default" in property)) continue;
          expect((schema.required ?? []).includes(name), `${method.toUpperCase()} ${path}: ${name} has a default and must not be required`).toBe(false);
        }
      }
    }
  });
});
