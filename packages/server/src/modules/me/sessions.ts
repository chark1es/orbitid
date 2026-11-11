/** Active-session and trusted-device routes. */
import type { Hono } from "hono";
import type { AppContext } from "../../context";
import { and, desc, eq } from "drizzle-orm";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import * as s from "../../db/schema";
import { serializeSession, serializeTrustedDevice } from "../../serializers";
import { endSession, isSessionExpired } from "../../services/sessions";
import { listTrustedDevices, revokeTrustedDevice } from "../../services/trusted-devices";
import { requireReverification } from "../auth/reverification";
import { first } from "../../lib/db";
import type { MeHelpers } from "./helpers";

export function registerSessionRoutes(app: Hono, ctx: AppContext, helpers: MeHelpers) {
  const { auth } = helpers;

  // ───────────── active sessions ─────────────
  app.get("/sessions/active", async (c) => {
    const { session, user } = await auth(c);
    const rows = (await ctx.db.select().from(s.sessions)
          .where(and(eq(s.sessions.userId, user.id), eq(s.sessions.status, "active")))
          .orderBy(desc(s.sessions.lastActiveAt)))
      .filter((row) => row.id !== session.id && !isSessionExpired(ctx, row));
    return c.json({ response: (await Promise.all(rows.map((row) => serializeSession(ctx, row, { withUser: true })))) });
  });

  app.post("/sessions/:id/revoke", requireReverification(ctx, "first_factor", 10), async (c) => {
    const { user } = await auth(c);
    const id = c.req.param("id")!;
    const row = first(await ctx.db.select().from(s.sessions).where(and(eq(s.sessions.id, id), eq(s.sessions.userId, user.id))));
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Session not found");
    const updated = await endSession(ctx, row, "revoked");
    return c.json({ response: await serializeSession(ctx, updated, { withUser: true }) });
  });

  // ───────────── trusted devices ─────────────
  app.get("/trusted_devices", async (c) => {
    const { user } = await auth(c);
    return c.json({ response: (await listTrustedDevices(ctx, user.id)).map(serializeTrustedDevice) });
  });

  app.delete("/trusted_devices/:id", requireReverification(ctx, "first_factor", 10), async (c) => {
    const { user } = await auth(c);
    const id = c.req.param("id")!;
    // Scoped to the owner: another user's device id is indistinguishable from an unknown one.
    const row = await revokeTrustedDevice(ctx, user.id, id);
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Trusted device not found");
    return c.json({ response: { object: "trusted_device", id, deleted: true } });
  });
}
