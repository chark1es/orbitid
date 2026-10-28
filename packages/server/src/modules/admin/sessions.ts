// Backend API sessions & clients.
import { Hono, type Context } from "hono";
import { and, count, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { ErrorCodes, OrbitError, type ClientJSON } from "@orbitid/shared";
import { parseBody } from "../../lib/http";
import { sha256 } from "../../lib/crypto";
import * as s from "../../db/schema";
import { serializeSession } from "../../serializers";
import { signSessionToken } from "../../services/tokens";
import { emitEvent } from "../../services/webhooks";
import { audit } from "../../services/audit";
import type { AppContext } from "../../context";
import { listParams, page, parseOrderBy } from "./shared";
import { first } from "../../lib/db";

type SessionRow = typeof s.sessions.$inferSelect;
type ClientRow = typeof s.clients.$inferSelect;

const SESSION_ORDER_COLUMNS = { created_at: s.sessions.createdAt, updated_at: s.sessions.updatedAt, last_active_at: s.sessions.lastActiveAt, expire_at: s.sessions.expireAt };

async function sessionOrThrow(ctx: AppContext, id: string): Promise<SessionRow> {
  const row = first(await ctx.db.select().from(s.sessions).where(eq(s.sessions.id, id)));
  if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Session not found.", { param_name: "session_id" });
  return row;
}

async function serializeClient(ctx: AppContext, client: ClientRow): Promise<ClientJSON> {
  const sessions = (await ctx.db
      .select()
      .from(s.sessions)
      .where(eq(s.sessions.clientId, client.id))
      .orderBy(sql`${s.sessions.createdAt} DESC`));
  return {
    object: "client",
    id: client.id,
    sessions: await Promise.all(sessions.map((row) => serializeSession(ctx, row, { withUser: true }))),
    sign_in: null,
    sign_up: null,
    last_active_session_id: client.lastActiveSessionId,
    cookie_expires_at: null,
    created_at: client.createdAt,
    updated_at: client.updatedAt,
  };
}

export default function routes(ctx: AppContext) {
  const app = new Hono();

  app.get("/sessions", async (c) => {
    const { limit, offset, order_by } = listParams(c);
    const conds: SQL[] = [];
    for (const [param, column] of [
      ["user_id", s.sessions.userId],
      ["client_id", s.sessions.clientId],
      ["status", s.sessions.status],
    ] as const) {
      const value = c.req.query(param);
      if (value) conds.push(eq(column, value));
    }
    if (c.req.query("expired") === "false") conds.push(sql`${s.sessions.expireAt} > ${Date.now()}`);
    const where = conds.length ? and(...conds) : undefined;
    const rows = (await ctx.db
          .select()
          .from(s.sessions)
          .where(where)
          .orderBy(parseOrderBy(order_by, SESSION_ORDER_COLUMNS, "-created_at"))
          .limit(limit)
          .offset(offset));
    const total = Number(first(await ctx.db.select({ n: count() }).from(s.sessions).where(where))?.n ?? 0);
    return c.json(page((await Promise.all(rows.map((row) => serializeSession(ctx, row, { withUser: true })))), total));
  });

  app.get("/sessions/:id", async (c) => c.json(await serializeSession(ctx, await sessionOrThrow(ctx, c.req.param("id")), { withUser: true })));

  app.post("/sessions/:id/revoke", async (c) => {
    const row = await sessionOrThrow(ctx, c.req.param("id") ?? "");
    await ctx.db.update(s.sessions).set({ status: "revoked", updatedAt: Date.now() }).where(eq(s.sessions.id, row.id));
    const updated = await sessionOrThrow(ctx, row.id);
    await emitEvent(ctx, "session.revoked", await serializeSession(ctx, updated, { withUser: true }));
    await audit(ctx, { actor: "secret_key", action: "session.revoked", targetType: "session", targetId: row.id, metadata: { user_id: row.userId } });
    return c.json(await serializeSession(ctx, updated, { withUser: true }));
  });

  app.post("/sessions/:id/verify", async (c) => {
    const row = await sessionOrThrow(ctx, c.req.param("id") ?? "");
    const user = first(await ctx.db.select().from(s.users).where(eq(s.users.id, row.userId)));
    const now = Date.now();
    const mfaEnabled = !!user && (user.totpVerified || !!user.backupCodes?.length);
    await ctx.db
                  .update(s.sessions)
                  .set({ firstFactorVerifiedAt: now, secondFactorVerifiedAt: mfaEnabled ? now : row.secondFactorVerifiedAt, updatedAt: now })
                  .where(eq(s.sessions.id, row.id));
    await audit(ctx, { actor: "secret_key", action: "session.verified", targetType: "session", targetId: row.id });
    return c.json(await serializeSession(ctx, await sessionOrThrow(ctx, row.id), { withUser: true }));
  });

  const mint = async (c: Context) => {
    const row = await sessionOrThrow(ctx, c.req.param("id") ?? "");
    if (row.status !== "active") throw new OrbitError(400, ErrorCodes.authentication_invalid, "Session is not active.");
    const template = c.req.param("template");
    if (template && !first(await ctx.db.select().from(s.jwtTemplates).where(eq(s.jwtTemplates.name, template)))) {
      throw new OrbitError(404, ErrorCodes.resource_not_found, "JWT template not found.", { param_name: "template" });
    }
    const jwt = await signSessionToken(ctx, row.id, template ? { template } : {});
    return c.json({ object: "token", jwt });
  };

  app.post("/sessions/:id/tokens", mint);
  app.post("/sessions/:id/tokens/:template", mint);

  app.get("/clients/:id", async (c) => {
    const client = first(await ctx.db.select().from(s.clients).where(eq(s.clients.id, c.req.param("id"))));
    if (!client) throw new OrbitError(404, ErrorCodes.resource_not_found, "Client not found.");
    return c.json(await serializeClient(ctx, client));
  });

  app.post("/clients/verify", async (c) => {
    const body = await parseBody(c, z.object({ token: z.string() }));
    const client = first(await ctx.db.select().from(s.clients).where(eq(s.clients.tokenHash, sha256(body.token))));
    if (!client) throw new OrbitError(404, ErrorCodes.resource_not_found, "Client not found.");
    return c.json(await serializeClient(ctx, client));
  });

  return app;
}
