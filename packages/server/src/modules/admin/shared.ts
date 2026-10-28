// Shared request/response helpers for the Backend API modules.
import type { Context } from "hono";
import { asc, desc, eq, type AnyColumn, type SQL } from "drizzle-orm";
import { z } from "zod";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import { validate } from "../../lib/http";
import * as s from "../../db/schema";
import type { AppContext } from "../../context";

/** Accepts JSON booleans plus urlencoded `"true"`/`"false"`/`"1"`/`"0"`. */
export const bool = z.preprocess((value) => {
  if (typeof value === "string") return value === "true" || value === "1";
  return value;
}, z.boolean());

export const metadataSchema = z.record(z.string(), z.unknown());

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

export function getUserOrThrow(ctx: AppContext, id: string): typeof s.users.$inferSelect {
  const user = ctx.db.select().from(s.users).where(eq(s.users.id, id)).get();
  if (!user) throw new OrbitError(404, ErrorCodes.resource_not_found, "User not found.", { param_name: "user_id" });
  return user;
}

/**
 * Deep-merges `patch` into `base`; `null` deletes the key. Used by `PATCH /users/:id/metadata` and instance settings.
 */
export function mergeMetadata(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete out[key];
      continue;
    }
    const current = out[key];
    const bothObjects = !!value && typeof value === "object" && !Array.isArray(value) && !!current && typeof current === "object" && !Array.isArray(current);
    out[key] = bothObjects ? mergeMetadata(current as Record<string, unknown>, value as Record<string, unknown>) : value;
  }
  return out;
}

/** Absolute link for tickets. The app origin comes from `settings.application.homeUrl`. */
export function ticketUrl(ctx: AppContext, path: string, ticket: string): string {
  const base = ctx.settings.get().application.homeUrl.replace(/\/$/, "");
  return `${base}${path}?__orbit_ticket=${encodeURIComponent(ticket)}`;
}
