import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../src/db/schema";
import { signSessionToken } from "../../src/services/tokens";
import { insertClientSession, insertUser, setup } from "../machine/helpers";

describe("credential management honours session inactivity", () => {
  it.each(["cookie-preferred", "cookie-fallback", "jwt"] as const)("refuses an idle %s session", async (credential) => {
    const { app, ctx } = await setup();
    await ctx.settings.update({ session: { inactivityTimeoutSeconds: 60 } });
    const user = await insertUser(ctx);
    const session = await insertClientSession(ctx, user.userId);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (credential === "jwt") headers.authorization = `Bearer ${await signSessionToken(ctx, session.sessionId)}`;
    else headers.cookie = session.cookie;
    if (credential === "cookie-fallback") {
      await ctx.db.update(s.clients).set({ lastActiveSessionId: null }).where(eq(s.clients.id, session.clientId));
    }
    const createKey = () => app.request("/v1/client/me/api_keys", {
      method: "POST", headers, body: JSON.stringify({ name: "Personal key" }),
    });
    expect((await createKey()).status).toBe(201);

    // The absolute session expiry and JWT are still valid; only the inactivity policy has elapsed.
    await ctx.db.update(s.sessions).set({ lastActiveAt: Date.now() - 120_000 }).where(eq(s.sessions.id, session.sessionId));
    const refused = await createKey();
    expect(refused.status).toBe(401);
    expect((await refused.json()).errors[0].code).toBe("authentication_invalid");
    expect(await ctx.db.select().from(s.apiKeys)).toHaveLength(1);
  });
});
