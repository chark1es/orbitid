import { isRecord } from "./object";

/** Keys whose values are user-defined maps and must never be key-transformed. */
const OPAQUE_VALUE_KEYS: Record<string, true> = {
  public_metadata: true,
  private_metadata: true,
  unsafe_metadata: true,
  metadata: true,
  claims: true,
  publicMetadata: true,
  privateMetadata: true,
  unsafeMetadata: true,
};

export type CamelCaseKey<S extends string> = S extends `${infer Head}_${infer Tail}` ? `${Head}${Capitalize<CamelCaseKey<Tail>>}` : S;

export type SnakeCaseKey<S extends string> = S extends `${infer Head}${infer Tail}` ? Head extends Uppercase<Head> ? `${Lowercase<Head>}_${SnakeCaseKey<Tail>}` : `${Head}${SnakeCaseKey<Tail>}` : S;

export type Camelize<T> = T extends null | undefined
  ? T
  : T extends string | number | boolean | bigint
    ? T
    : T extends readonly (infer U)[]
      ? Camelize<U>[]
      : T extends object
        ? { [K in keyof T as K extends string ? CamelCaseKey<K> : K]: Camelize<T[K]> }
        : T;

export function camelCaseKey(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

export function snakeCaseKey(key: string): string {
  return key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

export function camelizeDeep<T = unknown>(value: unknown): T {
  if (Array.isArray(value)) return value.map((item) => camelizeDeep(item)) as T;
  if (!isRecord(value)) return value as T;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[camelCaseKey(key)] = OPAQUE_VALUE_KEYS[key] ? item : camelizeDeep(item);
  }
  return result as T;
}

export function snakeizeDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => snakeizeDeep(item));
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const snakeKey = snakeCaseKey(key);
    result[snakeKey] = OPAQUE_VALUE_KEYS[key] || OPAQUE_VALUE_KEYS[snakeKey] ? item : snakeizeDeep(item);
  }
  return result;
}
