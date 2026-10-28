// Backend API one-time sign-in tokens and actor (impersonation) tokens.
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { ErrorCodes, ID_PREFIX, OrbitError, type ActorTokenJSON, type SignInTokenJSON } from "@orbitid/shared";
import { parseBody } from "../../lib/http";
import { randomToken, sha256 } from "../../lib/crypto";
import { newId } from "../../lib/ids";
import * as s from "../../db/schema";
import { audit } from "../../services/audit";
import type { AppContext } from "../../context";
import { getUserOrThrow, ticketUrl } from "./shared";

const signInTokenSchema = z.object({
  user_id: z.string(),
  /** 10s .. 30 days (Clerk limits); default 30 days. */
  expires_in_seconds: z.coerce.number().int().min(10).max(2_592_000).default(2_592_000),
});

const actorTokenSchema = z.object({
  user_id: z.string(),
  actor: z.object({ sub: z.string() }).passthrough(),
  /** 10s .. 12h; default 1h. */
  expires_in_seconds: z.coerce.number().int().min(10).max(43_200).default(3_600),
  session_max_duration_in_seconds: z.coerce.number().int().min(1).max(604_800).default(1_800),
});

function signInTokenJson(row: typeof s.signInTokens.$inferSelect, token?: string, url?: string): SignInTokenJSON {
  const json: SignInTokenJSON = {
    object: "sign_in_token",
    id: row.id,
    user_id: row.userId,
    status: row.status as SignInTokenJSON["status"],
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
  if (token) json.token = token;
  if (url) json.url = url;
  return json;
}

function actorTokenJson(row: typeof s.actorTokens.$inferSelect, token?: string): ActorTokenJSON {
  const json: ActorTokenJSON = {
    object: "actor_token",
    id: row.id,
    user_id: row.userId,
    actor: row.actor as ActorTokenJSON["actor"],
    status: row.status as ActorTokenJSON["status"],
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
  if (token) json.token = token;
  return json;
}

export default function routes(ctx: AppContext) {
  const app = new Hono();

  app.post("/sign_in_tokens", async (c) => {
    const body = await parseBody(c, signInTokenSchema);
    const user = getUserOrThrow(ctx, body.user_id);
    const token = randomToken(32);
    const now = Date.now();
    const row = ctx.db
      .insert(s.signInTokens)
      .values({ id: newId(ID_PREFIX.signInToken), userId: user.id, tokenHash: sha256(token), status: "pending", expiresAt: now + body.expires_in_seconds * 1000, createdAt: now, updatedAt: now })
      .returning()
      .get()!;
    audit(ctx, { actor: "secret_key", action: "sign_in_token.created", targetType: "user", targetId: user.id, metadata: { sign_in_token_id: row.id } });
    return c.json(signInTokenJson(row, token, ticketUrl(ctx, "/sign-in", token)));
  });

  app.post("/sign_in_tokens/:id/revoke", (c) => {
    const row = ctx.db.select().from(s.signInTokens).where(eq(s.signInTokens.id, c.req.param("id"))).get();
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Sign-in token not found.");
    ctx.db.update(s.signInTokens).set({ status: "revoked", updatedAt: Date.now() }).where(eq(s.signInTokens.id, row.id)).run();
    audit(ctx, { actor: "secret_key", action: "sign_in_token.revoked", targetType: "user", targetId: row.userId, metadata: { sign_in_token_id: row.id } });
    return c.json(signInTokenJson(ctx.db.select().from(s.signInTokens).where(eq(s.signInTokens.id, row.id)).get()!));
  });

  app.post("/actor_tokens", async (c) => {
    const body = await parseBody(c, actorTokenSchema);
    const user = getUserOrThrow(ctx, body.user_id);
    const token = randomToken(32);
    const now = Date.now();
    const row = ctx.db
      .insert(s.actorTokens)
      .values({
        id: newId(ID_PREFIX.actorToken),
        userId: user.id,
        actor: body.actor,
        tokenHash: sha256(token),
        status: "pending",
        expiresAt: now + body.expires_in_seconds * 1000,
        sessionMaxDurationSeconds: body.session_max_duration_in_seconds,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get()!;
    audit(ctx, { actor: "secret_key", action: "actor_token.created", targetType: "user", targetId: user.id, metadata: { actor_token_id: row.id, actor_sub: body.actor.sub } });
    return c.json(actorTokenJson(row, token));
  });

  app.post("/actor_tokens/:id/revoke", (c) => {
    const row = ctx.db.select().from(s.actorTokens).where(eq(s.actorTokens.id, c.req.param("id"))).get();
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Actor token not found.");
    ctx.db.update(s.actorTokens).set({ status: "revoked", updatedAt: Date.now() }).where(eq(s.actorTokens.id, row.id)).run();
    audit(ctx, { actor: "secret_key", action: "actor_token.revoked", targetType: "user", targetId: row.userId, metadata: { actor_token_id: row.id } });
    return c.json(actorTokenJson(ctx.db.select().from(s.actorTokens).where(eq(s.actorTokens.id, row.id)).get()!));
  });

  return app;
}
