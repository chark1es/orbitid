/**
 * Small builders for the JSON Schema subset the OpenAPI document uses.
 *
 * The document is written as TypeScript so the compiler checks every reference and the drift tests can walk it.
 * Schemas are draft 2020-12 (OpenAPI 3.1); `nullable()` is expressed as `["type", "null"]` rather than OpenAPI 3.0's
 * `nullable: true`.
 */

export type Schema = Record<string, unknown>;

/** A property that is not in the object's `required` list. */
export class Optional {
  constructor(readonly schema: Schema) {}
}

export const opt = (schema: Schema): Optional => new Optional(schema);

export const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });

export interface ObjectOptions {
  description?: string;
  /** `false` closes the object; a schema validates the values of unknown keys. Defaults to an open object. */
  additional?: boolean | Schema;
  example?: unknown;
}

export function obj(properties: Record<string, Schema | Optional>, options: ObjectOptions = {}): Schema {
  const props: Record<string, Schema> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(properties)) {
    if (value instanceof Optional) props[key] = value.schema;
    else {
      props[key] = value;
      required.push(key);
    }
  }
  const schema: Schema = { type: "object", properties: props };
  if (required.length) schema.required = required;
  if (options.additional === false) schema.additionalProperties = false;
  else if (options.additional) schema.additionalProperties = options.additional;
  if (options.description) schema.description = options.description;
  if (options.example !== undefined) schema.example = options.example;
  return schema;
}

export function arr(items: Schema, options: { description?: string; minItems?: number; maxItems?: number } = {}): Schema {
  const schema: Schema = { type: "array", items };
  if (options.description) schema.description = options.description;
  if (options.minItems !== undefined) schema.minItems = options.minItems;
  if (options.maxItems !== undefined) schema.maxItems = options.maxItems;
  return schema;
}

export function str(options: { description?: string; format?: string; enum?: string[]; maxLength?: number; minLength?: number; default?: unknown; example?: unknown; pattern?: string } = {}): Schema {
  const schema: Schema = { type: "string" };
  if (options.format) schema.format = options.format;
  if (options.enum) schema.enum = options.enum;
  if (options.maxLength !== undefined) schema.maxLength = options.maxLength;
  if (options.minLength !== undefined) schema.minLength = options.minLength;
  if (options.default !== undefined) schema.default = options.default;
  if (options.example !== undefined) schema.example = options.example;
  if (options.pattern) schema.pattern = options.pattern;
  if (options.description) schema.description = options.description;
  return schema;
}

export const int = (options: { description?: string; minimum?: number; maximum?: number; default?: unknown; example?: unknown } = {}): Schema => ({
  type: "integer",
  ...(options.minimum !== undefined ? { minimum: options.minimum } : {}),
  ...(options.maximum !== undefined ? { maximum: options.maximum } : {}),
  ...(options.default !== undefined ? { default: options.default } : {}),
  ...(options.example !== undefined ? { example: options.example } : {}),
  ...(options.description ? { description: options.description } : {}),
});

export const bool = (options: { description?: string; default?: boolean } = {}): Schema => ({
  type: "boolean",
  ...(options.default !== undefined ? { default: options.default } : {}),
  ...(options.description ? { description: options.description } : {}),
});

export const enm = (values: readonly string[], description?: string): Schema => ({
  type: "string",
  enum: [...values],
  ...(description ? { description } : {}),
});

export const lit = (value: string | number | boolean): Schema => ({ const: value });

/** `null` in addition to the given schema (OpenAPI 3.1 uses a type array, not `nullable: true`). */
export function nullable(schema: Schema): Schema {
  const type = schema.type;
  if (typeof type === "string") return { ...schema, type: [type, "null"] };
  return { anyOf: [schema, { type: "null" }] };
}

export const anyOf = (...schemas: Schema[]): Schema => ({ anyOf: schemas });

/** An arbitrary JSON object (`Record<string, unknown>`): metadata, claims, settings trees. */
export const freeObject = (description?: string | { description?: string }): Schema => {
  const text = typeof description === "string" ? description : description?.description;
  return { type: "object", additionalProperties: true, ...(text ? { description: text } : {}) };
};

export const anyJson = (description?: string | { description?: string }): Schema => {
  const text = typeof description === "string" ? description : description?.description;
  return text ? { description: text } : {};
};

/** `{ response: T }`, the Frontend API envelope. */
export const fapi = (item: Schema): Schema => obj({ response: item });

/** `{ object, id, deleted: true }`. */
export const deletedObject = (object: string): Schema => obj({ object: lit(object), id: str(), deleted: lit(true) });
