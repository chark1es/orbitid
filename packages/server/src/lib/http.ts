import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";
import { z, ZodError, type ZodTypeAny } from "zod";
import { OrbitError, ErrorCodes } from "@orbitid/shared";

/** JSON bodies are capped at 1 MB and multipart/form uploads at 5 MB (before any parsing happens). */
export const MAX_JSON_BYTES = 1024 * 1024;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
/** Deeper documents are refused: they only exist to exhaust the stack in recursive validators. */
export const MAX_JSON_DEPTH = 32;

const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Removes `__proto__` / `constructor` / `prototype` keys at every level, so a merge cannot reach a prototype. */
export function stripPrototypeKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => stripPrototypeKeys(item)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (PROTOTYPE_KEYS.has(key)) continue;
      Object.defineProperty(out, key, { value: stripPrototypeKeys(item), enumerable: true, writable: true, configurable: true });
    }
    return out as unknown as T;
  }
  return value;
}

/** Throws `request_body_invalid` when the document nests deeper than `MAX_JSON_DEPTH`. */
export function assertJsonDepth(value: unknown, max = MAX_JSON_DEPTH): void {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  while (stack.length) {
    const { value: current, depth } = stack.pop()!;
    if (!current || typeof current !== "object") continue;
    if (depth >= max) throw new OrbitError(400, ErrorCodes.request_body_invalid, "Request body is nested too deeply");
    for (const item of Array.isArray(current) ? current : Object.values(current as Record<string, unknown>)) {
      stack.push({ value: item, depth: depth + 1 });
    }
  }
}

/** Human-readable cap, in KB below a megabyte so a small test cap does not read as "0 KB". */
const describeBytes = (bytes: number) => (bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MB` : `${Math.round(bytes / 1024)} KB`);

/** Reads a body with a hard byte cap; the stream is cancelled as soon as the cap is crossed. */
export async function readBodyCapped(c: Context, maxBytes = MAX_JSON_BYTES): Promise<string> {
  const declared = Number(c.req.header("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new OrbitError(413, ErrorCodes.request_body_invalid, `Request body must be smaller than ${describeBytes(maxBytes)}`);
  }
  const raw = c.req.raw.body;
  if (!raw) return "";
  const reader = raw.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new OrbitError(413, ErrorCodes.request_body_invalid, `Request body must be smaller than ${describeBytes(maxBytes)}`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Parses a JSON or application/x-www-form-urlencoded body with zod. Throws a 422 OrbitError on failure. */
export async function parseBody<S extends ZodTypeAny>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown = {};
  const ct = c.req.header("content-type") ?? "";
  const declared = Number(c.req.header("content-length") ?? NaN);
  // A Request constructed in-process (tests, middleware) has no content-length header but does have a body.
  const hasBody = (Number.isFinite(declared) && declared > 0) || !!c.req.raw.body;
  try {
    if (ct.includes("application/json")) {
      const text = await readBodyCapped(c, MAX_JSON_BYTES);
      raw = text.trim() ? JSON.parse(text) : {};
    } else if (ct.includes("form")) {
      if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) {
        throw new OrbitError(413, ErrorCodes.request_body_invalid, "Request body is too large");
      }
      raw = Object.fromEntries(Object.entries(await c.req.parseBody()));
    } else if (hasBody) {
      throw new OrbitError(415, ErrorCodes.request_body_invalid, "Content-Type must be application/json or application/x-www-form-urlencoded");
    }
  } catch (err) {
    if (err instanceof OrbitError) throw err;
    throw new OrbitError(400, ErrorCodes.request_body_invalid, "Request body is not valid");
  }
  if (raw && typeof raw === "object") assertJsonDepth(raw);
  return validate(schema, raw === null ? {} : stripPrototypeKeys(raw));
}
export function validate<S extends ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  // `reportInput` keeps the offending value on each issue, so a missing field can be told apart from a wrong one
  // without parsing zod's message text.
  const r = schema.safeParse(value, { reportInput: true });
  if (!r.success) throw zodToOrbit(r.error);
  return r.data;
}

/**
 * zod 4 dropped `received` from `invalid_type` issues. The issue carries the offending input when the parse asked for
 * it; otherwise (an error raised elsewhere, such as re-validating stored settings) the message names it.
 */
function isMissingIssue(issue: z.core.$ZodIssue): boolean {
  if (issue.code !== "invalid_type") return false;
  return "input" in issue ? (issue as { input?: unknown }).input === undefined : /received undefined$/.test(issue.message);
}

export function zodToOrbit(err: ZodError): OrbitError {
  const first = err.issues[0]!;
  const param = first.path.join(".") || undefined;
  const missing = isMissingIssue(first);
  const e = new OrbitError(422, missing ? ErrorCodes.form_param_missing : ErrorCodes.form_param_format_invalid,
    missing ? `${param} is missing` : `${param ?? "body"}: ${first.message}`, { param_name: param });
  (e as any).items = err.issues.map((i) => new OrbitError(422, isMissingIssue(i) ? ErrorCodes.form_param_missing : ErrorCodes.form_param_format_invalid, i.message, { param_name: i.path.join(".") }).toItem());
  return e;
}

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(10),
  offset: z.coerce.number().int().min(0).default(0),
  order_by: z.string().optional(),
});
export function parsePagination(c: Context) { return validate(paginationSchema, c.req.query()); }

/**
 * The caller's address. Forwarding headers are client-controlled unless a proxy you run sets them, so by default
 * the socket address is used. Behind `n` trusted proxies set `ORBITID_TRUST_PROXY=n` (`true` means 1): the address
 * is then the nth entry from the right of `X-Forwarded-For`, the one your outermost proxy appended.
 */
let warnedMissingForwardedFor = false;
/** Once per process: a trusted proxy that sends no `X-Forwarded-For` makes every client share the proxy's address. */
function warnMissingForwardedFor(): void {
  if (warnedMissingForwardedFor || process.env.VITEST) return;
  warnedMissingForwardedFor = true;
  console.warn("[orbitid] ORBITID_TRUST_PROXY is set but a request arrived without an X-Forwarded-For hop; rate limits will treat every such client as the proxy. Make the proxy set X-Forwarded-For (see docs/SECURITY.md).");
}

export function clientIp(c: Context): string {
  const hops = process.env.ORBITID_TRUST_PROXY === "true" ? 1 : Number(process.env.ORBITID_TRUST_PROXY ?? 0);
  if (hops > 0) {
    const chain = (c.req.header("x-forwarded-for") ?? "").split(",").map((part) => part.trim()).filter(Boolean);
    // `X-Real-IP` is not consulted: a client could set it, and only the proxy-appended hop of `X-Forwarded-For` is trustworthy.
    const forwarded = chain[chain.length - hops];
    if (forwarded) return forwarded;
    warnMissingForwardedFor();
  }
  try {
    return getConnInfo(c).remote.address ?? "127.0.0.1";
  } catch {
    return "127.0.0.1";
  }
}
export const now = () => Date.now();
export const notFound = (what: string) => new OrbitError(404, ErrorCodes.resource_not_found, `${what} not found`);
