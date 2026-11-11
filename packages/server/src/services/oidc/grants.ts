// Lookups shared by the code exchange, refresh rotation, userinfo and introspection paths.
import { eq } from "drizzle-orm";
import type { AppContext } from "../../context";
import * as s from "../../db/schema";
import { sha256 } from "../../lib/crypto";
import { evaluateSessionStatus } from "../sessions";
import { first } from "../../lib/db";
import type { GrantRow } from "./shared";

export async function findGrantByToken(ctx: AppContext, token: string): Promise<GrantRow | null> {
  return first(await ctx.db.select().from(s.oauthGrants).where(eq(s.oauthGrants.tokenHash, sha256(token)))) ?? null;
}

export const isGrantLive = (row: GrantRow, at = Date.now()) => !row.revoked && row.expiresAt > at;

/**
 * Whether the browser session that authorized a grant is still live. A grant created without a session (device
 * flow / client credentials) has its own lifecycle and is not tied to a browser.
 */
export async function authorizingSessionActive(ctx: AppContext, sessionId: string | null | undefined): Promise<boolean> {
  if (!sessionId) return true;
  const row = first(await ctx.db.select().from(s.sessions).where(eq(s.sessions.id, sessionId)));
  if (!row) return false;
  const status = await evaluateSessionStatus(ctx, row);
  return status === "active" || status === "pending";
}
