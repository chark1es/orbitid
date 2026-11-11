// The durable `__client` cookie must roll forward while a browser is actively used, or the credential disappears at
// the 400-day browser cap even though the account never signed out.
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { COOKIE_MAX_AGE_SECONDS } from "@orbitid/shared";
import * as schema from "../../src/db/schema";
import { sha256 } from "../../src/lib/crypto";
import { setup, signUpUser } from "./helpers";

const DAY = 86_400_000;

const clientToken = (cookie: string | undefined): string => {
  const match = /(?:^|;\s*)__client=([^;]+)/.exec(cookie ?? "");
  if (!match) throw new Error("no __client cookie");
  return decodeURIComponent(match[1]!);
};

describe("durable client cookie", () => {
  afterEach(() => vi.useRealTimers());

  it("re-issues the same token once a day so 400 days of regular use is safe", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.UTC(2026, 0, 1);
    vi.setSystemTime(start);
    const { app, ctx } = await setup();
    const user = await signUpUser(app);
    const token = clientToken(user.client.cookie);
    const stored = (await ctx.db.select().from(schema.clients).where(eq(schema.clients.tokenHash, sha256(token))))[0]!;
    expect(stored.tokenIssuedAt).toBe(start);

    // 401 consecutive days of a browser that is opened and used once a day.
    for (let day = 1; day <= 401; day++) {
      vi.setSystemTime(start + day * DAY);
      const response = await user.client.request("/v1/client");
      expect(response.status).toBe(200);
      const cookies = response.headers.getSetCookie();
      const clientCookie = cookies.find((line) => line.startsWith("__client="));
      expect(clientCookie, `day ${day} must refresh the cookie`).toBeTruthy();
      expect(clientCookie).toContain(`Max-Age=${COOKIE_MAX_AGE_SECONDS}`);
      // Same value, no rotation: another tab's cookie stays valid.
      expect(decodeURIComponent(clientCookie!.split(";")[0]!.slice("__client=".length))).toBe(token);
    }

    const after = (await ctx.db.select().from(schema.clients).where(eq(schema.clients.id, stored.id)))[0]!;
    expect(after.tokenHash).toBe(stored.tokenHash);
    expect(after.tokenIssuedAt).toBe(start + 401 * DAY);
  });

  it("re-issues the cookie on token refresh and on the handshake too", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.UTC(2026, 0, 1);
    vi.setSystemTime(start);
    const { app } = await setup();
    const user = await signUpUser(app);
    const token = clientToken(user.client.cookie);

    vi.setSystemTime(start + 2 * DAY);
    const refresh = await user.client.request(`/v1/client/sessions/${user.sessionId}/tokens`, { method: "POST" });
    expect(refresh.status).toBe(200);
    expect(refresh.headers.getSetCookie().some((line) => line.startsWith(`__client=${token}`))).toBe(true);

    vi.setSystemTime(start + 3 * DAY);
    const handshake = await user.client.request(`/v1/client/handshake?redirect_url=${encodeURIComponent("http://localhost:3000/")}`, {
      headers: { accept: "text/html" },
    });
    expect(handshake.status).toBe(302);
    expect(handshake.headers.getSetCookie().some((line) => line.startsWith(`__client=${token}`))).toBe(true);
  });

  it("does not rewrite the cookie on every request", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.UTC(2026, 0, 1);
    vi.setSystemTime(start);
    const { app } = await setup();
    const user = await signUpUser(app);
    vi.setSystemTime(start + 60_000);
    const response = await user.client.request("/v1/client");
    expect(response.headers.getSetCookie().some((line) => line.startsWith("__client="))).toBe(false);
  });
});
