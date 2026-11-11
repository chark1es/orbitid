// Refresh-token replay grace: the window is measured from the original consumption, not from the successor's
// creation, so replaying an old token cannot keep a grant alive by rotating it forever.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { insertClientSession, insertUser, setup } from "../machine/helpers";
import { codeFlow, createApp, form, type Harness } from "./oidc-provider-helpers";

describe("OIDC — refresh token replay grace", () => {
  let h: Harness;
  let user: Awaited<ReturnType<typeof insertUser>>;
  let session: Awaited<ReturnType<typeof insertClientSession>>;
  let app: { id: string; client_id: string; client_secret?: string };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 0, 1));
    h = await setup();
    user = await insertUser(h.ctx);
    session = await insertClientSession(h.ctx, user.userId);
    app = await createApp(h);
  });
  afterEach(() => vi.useRealTimers());

  const refresh = (token: string) => form(h, "/oauth/token", {
    grant_type: "refresh_token", refresh_token: token, client_id: app.client_id!, client_secret: app.client_secret ?? "",
  });

  it("returns the same successor inside the window and never extends it", async () => {
    const start = Date.UTC(2026, 0, 1);
    const { tokens } = await codeFlow(h, app, session.cookie);
    const original = tokens.refresh_token!;

    vi.setSystemTime(start + 20_000);
    const first = await refresh(original);
    expect(first.status).toBe(200);
    const successor = (await first.json() as { refresh_token: string }).refresh_token;
    expect(successor).toBeTruthy();
    expect(successor).not.toBe(original);

    // 20 s after the *original* consumption: still a retry, and idempotent — the exact same successor comes back.
    vi.setSystemTime(start + 40_000);
    const retry = await refresh(original);
    expect(retry.status).toBe(200);
    expect((await retry.json() as { refresh_token: string }).refresh_token).toBe(successor);

    // No extra refresh rotation was recorded: original (consumed) + the one successor.
    const family = original && (await h.ctx.db.select().from(schema.oauthGrants).where(eq(schema.oauthGrants.kind, "refresh")));
    expect(family).toHaveLength(2);

    // 35 s after the original consumption: outside the 30 s window, the replay is theft.
    vi.setSystemTime(start + 55_000);
    const stale = await refresh(original);
    expect(stale.status).toBe(400);
    expect((await stale.json() as { error: string }).error).toBe("invalid_grant");
    // The whole family is revoked, including the successor the retry used to return.
    const rows = await h.ctx.db.select().from(schema.oauthGrants).where(eq(schema.oauthGrants.kind, "refresh"));
    expect(rows.every((row) => row.revoked)).toBe(true);
    expect((await refresh(successor)).status).toBe(400);
  });

  it("records consumption time and successor on the consumed token", async () => {
    const { tokens } = await codeFlow(h, app, session.cookie);
    expect((await refresh(tokens.refresh_token!)).status).toBe(200);
    const consumed = (await h.ctx.db.select().from(schema.oauthGrants).where(eq(schema.oauthGrants.kind, "refresh")))
      .find((row) => row.revoked)!;
    expect(consumed.consumedAt).toBe(Date.now());
    expect(consumed.successorId).toBeTruthy();
    const successor = (await h.ctx.db.select().from(schema.oauthGrants).where(eq(schema.oauthGrants.id, consumed.successorId!)))[0]!;
    expect(successor.revoked).toBe(false);
  });
});
