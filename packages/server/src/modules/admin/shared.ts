// Shared request/response helpers for the Backend API modules.
import type { Context } from "hono";
import { asc, desc, eq, type AnyColumn, type SQL } from "drizzle-orm";
import { z } from "zod";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import { validate } from "../../lib/http";
import * as s from "../../db/schema";
import type { AppContext } from "../../context";
import { first } from "../../lib/db";

/** Accepts JSON booleans plus urlencoded `"true"`/`"false"`/`"1"`/`"0"`. */
export const bool = z.preprocess((value) => {
  if (typeof value === "string") return value === "true" || value === "1";
  return value;
}, z.boolean());

/** A bounded metadata blob: at most 100 keys, 256-char keys, 4 KB strings, 16 KB overall. */
const metadataValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string().max(4096),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(metadataValue).max(100),
    z.record(z.string().max(256), metadataValue),
  ]),
);

export const metadataSchema = z.record(z.string().max(256), metadataValue)
  .refine((value) => Object.keys(value).length <= 100, { message: "metadata may contain at most 100 keys" })
  .refine((value) => {
    try {
      return JSON.stringify(value).length <= 16 * 1024;
    } catch {
      return false;
    }
  }, { message: "metadata must serialize to at most 16 KB" });

export const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(10),
  offset: z.coerce.number().int().min(0).default(0),
  order_by: z.string().optional(),
});

export function listParams(c: Context) {
  return validate(listSchema, c.req.query());
}

export const page = <T>(data: T[], total_count: number) => ({ data, total_count });

export const deleted = (object: string, id: string) => ({ object, id, deleted: true as const });

/** Repeated (`?a=1&a=2`), comma separated (`?a=1,2`) and single query values. */
export function queryValues(c: Context, name: string): string[] {
  const values = [...(c.req.queries(name) ?? []), ...(c.req.query(name) ? [c.req.query(name)!] : [])];
  return [...new Set(values.flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean))];
}

export function parseOrderBy(raw: string | undefined, columns: Record<string, AnyColumn>, fallback: string): SQL {
  const requested = raw?.replace(/^[+-]/, "") ?? "";
  const spec = raw && columns[requested] ? raw : fallback;
  const direction = spec.startsWith("-") ? desc : asc;
  return direction(columns[spec.replace(/^[+-]/, "")]!);
}

export const normalizeEmail = (value: string) => value.trim().toLowerCase();

export async function getUserOrThrow(ctx: AppContext, id: string): Promise<typeof s.users.$inferSelect> {
  const user = first(await ctx.db.select().from(s.users).where(eq(s.users.id, id)));
  if (!user) throw new OrbitError(404, ErrorCodes.resource_not_found, "User not found.", { param_name: "user_id" });
  return user;
}

const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Deep-merges `patch` into `base`; `null` deletes the key. Used by `PATCH /users/:id/metadata` and instance settings.
 * `__proto__`, `constructor` and `prototype` keys are ignored at every level, so a merge can never reach a prototype.
 */
export function mergeMetadata(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (PROTOTYPE_KEYS.has(key)) continue;
    if (value === null) {
      delete out[key];
      continue;
    }
    const current = out[key];
    const bothObjects = !!value && typeof value === "object" && !Array.isArray(value) && !!current && typeof current === "object" && !Array.isArray(current);
    Object.defineProperty(out, key, {
      value: bothObjects ? mergeMetadata(current as Record<string, unknown>, value as Record<string, unknown>) : value,
      enumerable: true, writable: true, configurable: true,
    });
  }
  return out;
}

/** Absolute link for tickets. The app origin comes from `settings.application.homeUrl`. */
export function ticketUrl(ctx: AppContext, path: string, ticket: string): string {
  const base = ctx.settings.get().application.homeUrl.replace(/\/$/, "");
  return `${base}${path}?__orbit_ticket=${encodeURIComponent(ticket)}`;
}
