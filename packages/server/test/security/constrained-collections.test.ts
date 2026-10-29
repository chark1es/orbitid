import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Hono } from "hono";
import { OrbitError } from "@orbitid/shared";
import { MAX_JSON_BYTES, parseBody, validate } from "../../src/lib/http";

/**
 * Regression guard for GHSA-mrhx-c7xc-m3w5 (zod < 4.6.6: memory exhaustion while validating oversized constrained
 * collections). zod 3 validated every element and only then compared the length to `.max()`; zod 4 checks the length
 * first and stops. These tests assert the property that actually makes the endpoint safe — no element work for an
 * over-long array — rather than relying on the request-body cap alone, which bounds bytes but not the cost per byte.
 */

describe("oversized constrained collections", () => {
  it("rejects an over-long array without validating its elements", () => {
    let visited = 0;
    const element = z.string().refine(() => { visited += 1; return true; });
    const schema = z.array(element).max(3);

    const result = schema.safeParse(new Array(50_000).fill("x"));

    expect(result.success).toBe(false);
    expect(result.error!.issues[0]).toMatchObject({ code: "too_big", maximum: 3 });
    // zod 3 visited all 50 000 elements before comparing the length; that walk is what the advisory exploited.
    expect(visited).toBe(0);
  });

  it("does the same for a nested constrained array", () => {
    let visited = 0;
    const schema = z.object({
      outer: z.array(z.object({ inner: z.array(z.string().refine(() => { visited += 1; return true; })).max(2) })).max(500),
    });

    const result = schema.safeParse({ outer: [{ inner: new Array(50_000).fill("x") }] });

    expect(result.success).toBe(false);
    expect(visited).toBe(0);
  });

  it("still validates within the bound", () => {
    const schema = z.array(z.string().max(2)).max(3);
    expect(schema.safeParse(["ok", "no"]).success).toBe(true);
    expect(schema.safeParse(["toolong"]).success).toBe(false);
    expect(schema.safeParse(["a", "b", "c", "d"]).success).toBe(false);
  });

  it("documents that key-count limits enforced by `.refine` still visit every value", () => {
    // The metadata schemas bound the number of keys with `.refine`, which runs after the object is built, so a huge
    // object is still walked. Nothing here claims the 1 MB body cap makes that cheap per byte: the bound is on what a
    // request may cost in bytes, and metadata values are separately capped (256-char keys, 4 KB strings, 16 KB total).
    let visited = 0;
    const value = z.string().refine(() => { visited += 1; return true; });
    const schema = z.record(z.string().max(256), value).refine((v) => Object.keys(v).length <= 3);
    const many = Object.fromEntries(Array.from({ length: 1_000 }, (_, i) => [`k${i}`, "x"]));

    expect(schema.safeParse(many).success).toBe(false);
    expect(visited).toBe(1_000);
  });
});

describe("request bodies against the collection bound", () => {
  const schema = z.object({ tags: z.array(z.string().max(8)).max(3) });
  const app = new Hono()
    .onError((err, c) => {
      const orbit = err instanceof OrbitError ? err : null;
      const status = orbit?.status ?? 500;
      // Type-narrowing for Hono's status union: the only statuses this handler produces are 422 and 500.
      return c.json({ status, code: orbit?.code ?? "unknown" }, status === 422 ? 422 : 500);
    })
    .post("/", async (c) => c.json(await parseBody(c, schema)));

  it("refuses an array above the constraint with a 422 rather than reading every element", async () => {
    // Well inside the 1 MB body cap: the length constraint is what refuses it.
    const body = JSON.stringify({ tags: new Array(20_000).fill("tag") });
    expect(body.length).toBeLessThan(MAX_JSON_BYTES);

    const res = await app.request("/", { method: "POST", headers: { "content-type": "application/json" }, body });

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ status: 422, code: "form_param_format_invalid" });
  });

  it("accepts an array at the constraint", () => {
    expect(validate(schema, { tags: ["a", "b", "c"] })).toEqual({ tags: ["a", "b", "c"] });
  });
});
