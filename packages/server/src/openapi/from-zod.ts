/**
 * Converters from zod to the JSON Schema subset used by the OpenAPI document.
 *
 * The installed zod (3.25) ships `z.toJSONSchema` only through its `/v4` entry point, while the server's request
 * schemas are built with the v3 API (`z.object`, `z.enum`, …). Re-typing every request body in JSON Schema by hand
 * would let the two drift, so this walks the v3 schema definition instead. Only the constructs the server uses are
 * supported; anything else throws so a new construct cannot silently produce a wrong document.
 */
import { z } from "zod";
import type { Schema } from "./schema";

type ZodLike = z.ZodTypeAny;

interface Def {
  typeName?: string;
  type?: string;
  description?: string;
  checks?: { kind: string; value?: unknown; regex?: RegExp }[];
  values?: unknown[];
  value?: unknown;
  schema?: ZodLike;
  innerType?: ZodLike;
  typeName_?: string;
  defaultValue?: () => unknown;
  options?: ZodLike[];
  keyType?: ZodLike;
  valueType?: ZodLike;
}

const defOf = (schema: ZodLike): Def => (schema as unknown as { _def: Def })._def;

const withChecks = (schema: Schema, def: Def): Schema => {
  for (const check of def.checks ?? []) {
    switch (check.kind) {
      case "min":
        if (schema.type === "string") schema.minLength = check.value as number;
        else if (schema.type === "number" || schema.type === "integer") schema.minimum = check.value as number;
        else if (schema.type === "array") schema.minItems = check.value as number;
        break;
      case "max":
        if (schema.type === "string") schema.maxLength = check.value as number;
        else if (schema.type === "number" || schema.type === "integer") schema.maximum = check.value as number;
        else if (schema.type === "array") schema.maxItems = check.value as number;
        break;
      case "email": schema.format = "email"; break;
      case "url": schema.format = "uri"; break;
      case "uuid": schema.format = "uuid"; break;
      case "regex": schema.pattern = check.regex?.source; break;
      case "int": if (schema.type === "number") schema.type = "integer"; break;
      case "positive": schema.exclusiveMinimum = 0; break;
      case "nonnegative": schema.minimum = 0; break;
      default: break;
    }
  }
  if (def.description) schema.description = def.description;
  return schema;
};

/** JSON Schema for a zod (v3) schema. `io: "input"` keeps defaults optional, matching what a client may send. */
export function fromZod(input: ZodLike): Schema {
  const def = defOf(input);
  const name = def.typeName ?? `Zod${def.type ?? "Unknown"}`;
  switch (name) {
    case "ZodString": return withChecks({ type: "string" }, def);
    case "ZodNumber": return withChecks({ type: "number" }, def);
    case "ZodBigInt": return { type: "integer" };
    case "ZodBoolean": return { type: "boolean" };
    case "ZodNull": return { type: "null" };
    case "ZodAny": return {};
    case "ZodUnknown": return {};
    case "ZodNaive": return {};
    case "ZodVoid": return { type: "null" };
    case "ZodDate": return { type: "string", format: "date-time" };
    case "ZodLiteral": return { const: def.value as string | number | boolean };
    case "ZodEnum": return { type: "string", enum: (def.values as string[]).slice() };
    case "ZodNativeEnum": return { enum: Object.values((def.values ?? {}) as unknown as Record<string, string | number>) };
    case "ZodArray": return withChecks({ type: "array", items: fromZod(def.type as unknown as ZodLike) }, def);
    case "ZodObject": {
      const shape = (input as unknown as { shape: Record<string, ZodLike> }).shape;
      const properties: Record<string, Schema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = fromZod(value);
        if (!isOptional(value)) required.push(key);
      }
      const out: Schema = { type: "object", properties };
      if (required.length) out.required = required;
      return out;
    }
    case "ZodRecord": return { type: "object", additionalProperties: def.valueType ? fromZod(def.valueType) : true };
    case "ZodOptional":
    case "ZodNullable":
    case "ZodDefault":
    case "ZodReadonly": {
      const inner = fromZod(def.innerType as ZodLike);
      if (name === "ZodNullable") {
        if (typeof inner.type === "string") return { ...inner, type: [inner.type, "null"] };
        return { anyOf: [inner, { type: "null" }] };
      }
      if (name === "ZodDefault" && def.defaultValue) inner.default = def.defaultValue();
      return inner;
    }
    case "ZodEffects": {
      // `z.preprocess(fn, schema)` (the server's urlencoded boolean/list coercion) is described by its inner schema.
      const out = fromZod(def.schema as ZodLike);
      if (def.description) out.description = def.description;
      return out;
    }
    case "ZodUnion": return { anyOf: (def.options ?? []).map(fromZod) };
    case "ZodDiscriminatedUnion": return { anyOf: ((input as unknown as { options: Map<string, ZodLike> }).options).values && [...(input as unknown as { options: Map<string, ZodLike> }).options.values()].map(fromZod) };
    case "ZodTuple": return { type: "array", items: (def as unknown as { items: ZodLike[] }).items.map(fromZod) };
    case "ZodLazy": return fromZod((input as unknown as { _def: { getter: () => ZodLike } })._def.getter());
    case "ZodBranded": return fromZod(def.type as unknown as ZodLike);
    case "ZodCatch": return fromZod(def.innerType as ZodLike);
    case "ZodPipeline": return fromZod((def as unknown as { in: ZodLike }).in);
    default: throw new Error(`fromZod: unsupported zod type ${name}`);
  }
}

export const isOptional = (schema: ZodLike): boolean => {
  const def = defOf(schema);
  const name = def.typeName;
  if (name === "ZodOptional" || name === "ZodDefault" || name === "ZodCatch") return true;
  if (name === "ZodEffects") return isOptional(def.schema as ZodLike);
  if (name === "ZodNullable" || name === "ZodReadonly") return isOptional(def.innerType as ZodLike);
  return false;
};
