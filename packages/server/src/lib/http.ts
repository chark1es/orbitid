import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";
import { z, ZodError, type ZodTypeAny } from "zod";
import { OrbitError, ErrorCodes } from "@orbitid/shared";

/** Parses a JSON or application/x-www-form-urlencoded body with zod. Throws a 422 OrbitError on failure. */
export async function parseBody<S extends ZodTypeAny>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown = {};
  const ct = c.req.header("content-type") ?? "";
  try {
    if (ct.includes("application/json")) {
      const text = await c.req.text();
      raw = text.trim() ? JSON.parse(text) : {};
    }
    else if (ct.includes("form")) raw = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, v]));
  } catch {
    throw new OrbitError(400, ErrorCodes.request_body_invalid, "Request body is not valid");
  }
  return validate(schema, raw ?? {});
}
export function validate<S extends ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw zodToOrbit(r.error);
  return r.data;
}
export function zodToOrbit(err: ZodError): OrbitError {
  const first = err.issues[0]!;
  const param = first.path.join(".") || undefined;
  const missing = first.code === "invalid_type" && (first as any).received === "undefined";
  const e = new OrbitError(422, missing ? ErrorCodes.form_param_missing : ErrorCodes.form_param_format_invalid,
    missing ? `${param} is missing` : `${param ?? "body"}: ${first.message}`, { param_name: param });
  (e as any).items = err.issues.map((i) => new OrbitError(422, i.code === "invalid_type" && (i as any).received === "undefined" ? ErrorCodes.form_param_missing : ErrorCodes.form_param_format_invalid, i.message, { param_name: i.path.join(".") }).toItem());
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
export function clientIp(c: Context): string {
  const hops = process.env.ORBITID_TRUST_PROXY === "true" ? 1 : Number(process.env.ORBITID_TRUST_PROXY ?? 0);
  if (hops > 0) {
    const chain = (c.req.header("x-forwarded-for") ?? "").split(",").map((part) => part.trim()).filter(Boolean);
    const forwarded = chain[chain.length - hops] ?? c.req.header("x-real-ip");
    if (forwarded) return forwarded;
  }
  try {
    return getConnInfo(c).remote.address ?? "127.0.0.1";
  } catch {
    return "127.0.0.1";
  }
}
export const now = () => Date.now();
export const notFound = (what: string) => new OrbitError(404, ErrorCodes.resource_not_found, `${what} not found`);
