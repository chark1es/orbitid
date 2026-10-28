// Frontend API: POST /v1/client/waitlist
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { ErrorCodes, ID_PREFIX, OrbitError } from "@orbitid/shared";
import { clientIp, parseBody } from "../lib/http";
import { hit } from "../lib/rate-limit";
import { newId } from "../lib/ids";
import * as s from "../db/schema";
import { emitEvent } from "../services/webhooks";
import { audit } from "../services/audit";
import type { AppContext } from "../context";
import { normalizeEmail } from "./admin/shared";
import { serializeWaitlistEntry } from "./admin/waitlist";

export default function routes(ctx: AppContext) {
  const app = new Hono();

  app.post("/waitlist", async (c) => {
    if (ctx.settings.get().signUp.mode !== "waitlist") {
      throw new OrbitError(422, ErrorCodes.sign_up_mode_restricted, "The waitlist is not enabled for this instance.");
    }
    hit(ctx, `waitlist:${clientIp(c)}`, 5, 3_600_000);
    const body = await parseBody(c, z.object({ email_address: z.string().email() }));
    const email = normalizeEmail(body.email_address);

    const existing = ctx.db.select().from(s.waitlistEntries).where(eq(s.waitlistEntries.email, email)).get();
    if (existing) return c.json({ response: serializeWaitlistEntry(ctx, existing) });

    const now = Date.now();
    const row = ctx.db
      .insert(s.waitlistEntries)
      .values({ id: newId(ID_PREFIX.waitlist), email, status: "pending", createdAt: now, updatedAt: now })
      .returning()
      .get()!;
    const json = serializeWaitlistEntry(ctx, row);
    await emitEvent(ctx, "waitlistEntry.created", json);
    audit(ctx, { actor: "anonymous", action: "waitlist_entry.created", targetType: "waitlist_entry", targetId: row.id, metadata: { email_address: email } });
    return c.json({ response: json });
  });

  return app;
}
