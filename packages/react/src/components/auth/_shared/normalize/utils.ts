/**
 * `@orbitid/js` resources are camelCase classes; the UI records (and `@orbitid/shared` wire types)
 * are snake_case. These adapters expose the snake_case view *and* keep the live class prototype so
 * resource methods keep working. Cached per object and invalidated on every SDK state change.
 */

let epoch = 0;
export function invalidateNormalizedResources(): void {
  epoch += 1;
}

export interface Cached<T> {
  epoch: number;
  value: T;
}

export function cached<T extends object>(store: WeakMap<object, Cached<T>>, raw: object, build: () => T): T {
  const existing = store.get(raw);
  if (existing && existing.epoch === epoch) return existing.value;
  const value = build();
  store.set(raw, { epoch, value });
  return value;
}

export function read(record: Record<string, unknown>, snake: string, camel?: string): unknown {
  const value = record[snake];
  if (value !== undefined) return value;
  return camel ? record[camel] : undefined;
}

export function str(record: Record<string, unknown>, snake: string, camel?: string): string | null {
  const value = read(record, snake, camel);
  return typeof value === "string" ? value : null;
}

export function bool(record: Record<string, unknown>, snake: string, camel?: string, fallback = false): boolean {
  const value = read(record, snake, camel);
  return typeof value === "boolean" ? value : fallback;
}

export function num(record: Record<string, unknown>, snake: string, camel?: string): number | null {
  const value = read(record, snake, camel);
  return typeof value === "number" ? value : null;
}

export function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value.filter((entry) => entry !== null && entry !== undefined) as T[]) : [];
}

export function view<T extends object>(raw: T): T {
  return Object.assign(Object.create(Object.getPrototypeOf(raw)) as T, raw);
}

/** Defines own data properties so they shadow getter-only accessors inherited from the SDK resource prototype. */
export function define(target: object, props: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
  }
}

export function bindMethods(target: object, raw: Record<string, unknown>, names: readonly string[]): void {
  for (const name of names) {
    const method = raw[name];
    if (typeof method === "function") {
      define(target, { [name]: (...args: unknown[]) => (method as (...a: unknown[]) => unknown).apply(raw, args) });
    }
  }
}
