// Audit log persistence for Backend API mutations (`GET /v1/audit_logs`).
import { and, asc, desc, eq, gte, like, lte, sql, type SQL } from "drizzle-orm";
import { ID_PREFIX, type AuditLogJSON } from "@orbitid/shared";
import { newId } from "../lib/ids";
import * as s from "../db/schema";
import type { AppContext } from "../context";
import { first } from "../lib/db";

export interface AuditInput {
  /** Who performed the action: the secret key holder (`sk_...`), a user id, or `system`. */
  actor?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

/**
 * Appends an audit log entry. Never throws: auditing must not break the mutation it describes.
 */
export async function audit(ctx: AppContext, input: AuditInput): Promise<void> {
  try {
    await ctx.db
                  .insert(s.auditLogs)
                  .values({
                    id: newId(ID_PREFIX.audit),
                    actor: input.actor ?? null,
                    action: input.action,
                    targetType: input.targetType ?? null,
                    targetId: input.targetId ?? null,
                    metadata: input.metadata ?? {},
                    ip: input.ip ?? null,
                  });
  } catch (err) {
    console.error("[audit] failed to record entry", input.action, err);
  }
}

export function serializeAuditLog(row: typeof s.auditLogs.$inferSelect): AuditLogJSON {
  return {
    object: "audit_log",
    id: row.id,
    actor: row.actor,
    action: row.action,
    target_type: row.targetType,
    target_id: row.targetId,
    metadata: row.metadata ?? {},
    ip: row.ip,
    created_at: row.createdAt,
  };
}

export interface AuditLogFilters {
  limit: number;
  offset: number;
  /** `created_at` (ascending) or `-created_at` (descending, default). */
  orderBy?: string;
  actor?: string;
  /** Exact action, or a prefix pattern ending in `*` (`user.*`). */
  action?: string;
  targetType?: string;
  targetId?: string;
  after?: number;
  before?: number;
}

export async function listAuditLogs(ctx: AppContext, filters: AuditLogFilters): Promise<{ data: AuditLogJSON[]; total_count: number }> {
  const conds: SQL[] = [];
  if (filters.actor) conds.push(eq(s.auditLogs.actor, filters.actor));
  if (filters.action) {
    conds.push(filters.action.endsWith("*") ? like(s.auditLogs.action, `${filters.action.slice(0, -1)}%`) : eq(s.auditLogs.action, filters.action));
  }
  if (filters.targetType) conds.push(eq(s.auditLogs.targetType, filters.targetType));
  if (filters.targetId) conds.push(eq(s.auditLogs.targetId, filters.targetId));
  if (filters.after !== undefined) conds.push(gte(s.auditLogs.createdAt, filters.after));
  if (filters.before !== undefined) conds.push(lte(s.auditLogs.createdAt, filters.before));
  const where = conds.length ? and(...conds) : undefined;
  const rows = (await ctx.db
      .select()
      .from(s.auditLogs)
      .where(where)
      .orderBy(filters.orderBy === "created_at" ? asc(s.auditLogs.createdAt) : desc(s.auditLogs.createdAt))
      .limit(filters.limit)
      .offset(filters.offset));
  const total = first(await ctx.db.select({ n: sql<number>`count(*)` }).from(s.auditLogs).where(where))?.n ?? 0;
  return { data: rows.map(serializeAuditLog), total_count: total };
}
