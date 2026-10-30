/**
 * Converter from zod to the JSON Schema subset used by the OpenAPI document.
 *
 * Request schemas are written as zod so the handler and the document share one definition; re-typing every request
 * body in JSON Schema by hand would let the two drift. The conversion uses zod's public `z.toJSONSchema` rather than
 * reaching into the schema internals, so a zod upgrade cannot silently change the documented shape.
 *
 * `io: "input"` describes what a client may send: a field with a `.default()` stays optional and its default is
 * advertised. OpenAPI 3.1 is JSON Schema 2020-12, so the generated dialect matches the document.
 */
import { z } from "zod";
import type { Schema } from "./schema";

type ZodLike = z.ZodTypeAny;

/** `.int()` is `safeint` in zod; the sentinels would otherwise appear as min/maximum on every integer. */
const SAFE_INT_MIN = Number.MIN_SAFE_INTEGER;
const SAFE_INT_MAX = Number.MAX_SAFE_INTEGER;

const isNullSchema = (branch: unknown): boolean =>
  !!branch && typeof branch === "object" && Object.keys(branch).length === 1 && (branch as { type?: unknown }).type === "null";

/** `{ type: "string" }` and nothing else: a no-op constraint, because every JSON object key is already a string. */
const isStringOnlyPropertyNames = (value: unknown): boolean =>
  !!value && typeof value === "object" && Object.keys(value).length === 1 && (value as { type?: unknown }).type === "string";

/**
 * Removes what the OpenAPI document does not want: the `$schema` dialect marker (the document declares its own
 * dialect), zod's safe-integer bounds, and no-op `propertyNames` constraints.
 */
function normalize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalize);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "$schema") continue;
    out[key] = normalize(value);
  }
  // zod bounds every integer to the safe-integer range; that is an implementation detail, not a documented limit.
  if (out.type === "integer") {
    if (out.minimum === SAFE_INT_MIN) delete out.minimum;
    if (out.maximum === SAFE_INT_MAX) delete out.maximum;
  }
  // `propertyNames: { type: "string" }` is always true in JSON, where every object key is a string.
  if (isStringOnlyPropertyNames(out.propertyNames)) delete out.propertyNames;
  // `.nullable()` becomes `anyOf: [T, null]`. OpenAPI 3.1 allows `type: [T, "null"]`, which keeps the companion
  // keywords (`items`, `properties`, …) in one readable object, so fold the null branch back in when it is that simple.
  const { anyOf, ...rest } = out;
  if (Array.isArray(anyOf) && anyOf.length === 2 && anyOf.some(isNullSchema)) {
    const inner = anyOf.find((branch) => !isNullSchema(branch)) as { type?: unknown };
    if (typeof inner?.type === "string") return { ...rest, ...inner, type: [inner.type, "null"] };
  }
  return out;
}

/** JSON Schema for a zod schema, as a client would send it. Throws when a construct cannot be described. */
export function fromZod(input: ZodLike): Schema {
  let generated: unknown;
  try {
    generated = z.toJSONSchema(input, { io: "input", target: "draft-2020-12", cycles: "throw", reused: "inline" });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`fromZod: unsupported zod schema (${reason})`);
  }
  // A `$defs` block would hold JSON pointers relative to the document root, not to this schema, so the references
  // would resolve to the wrong place inside an OpenAPI operation. Fail loudly instead of publishing a broken document.
  if (generated && typeof generated === "object" && "$defs" in (generated as Record<string, unknown>)) {
    throw new Error("fromZod: recursive schemas cannot be inlined into an OpenAPI operation");
  }
  return normalize(generated) as Schema;
}
