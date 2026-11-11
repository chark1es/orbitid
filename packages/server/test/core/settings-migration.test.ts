// Upgrading an instance whose database still holds the *old* default settings tree. Old releases persisted the whole
// tree, so changing a default in code is not enough: a stored `lifetimeSeconds: 604800` would keep expiring sessions
// weekly forever. The versioned settings migration converts only values that equal the old defaults.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { defaultInstanceSettings, ID_PREFIX, SESSION_NEVER_EXPIRES_AT } from "@orbitid/shared";
import { createContext } from "../../src/bootstrap";
import { createDb, dialect } from "../../src/db";
import * as s from "../../src/db/schema";
import { newId } from "../../src/lib/ids";
import { CURRENT_SETTINGS_VERSION, createSettingsStore, SETTINGS_VERSION_KEY } from "../../src/settings";

const ENCRYPTION_KEY = "settings-migration-key".padEnd(32, "x");

const DAY = 86_400_000;

function persistentTarget() {
  const dir = mkdtempSync(join(tmpdir(), "orbitid-settings-migration-"));
  const databaseUrl = dialect === "postgres" ? `pglite:${join(dir, "pg")}` : `sqlite:${join(dir, "orbitid.db")}`;
  return { dir, databaseUrl, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function open(target: { dir: string; databaseUrl: string }) {
  return createContext({
    databaseUrl: target.databaseUrl,
    dataDir: target.dir,
    secretKey: "sk_test_settings_migration",
    baseUrl: "http://localhost:4000",
    nodeEnv: "test",
    encryptionKey: ENCRYPTION_KEY,
  });
}

async function seedSession(ctx: Awaited<ReturnType<typeof open>>, opts: { status: string; expireAt: number; createdAt: number; label: string }) {
  const userId = newId(ID_PREFIX.user);
  const clientId = newId(ID_PREFIX.client);
  const sessionId = newId(ID_PREFIX.session);
  await ctx.db.insert(s.users).values({
    id: userId, username: null, usernameLower: null, firstName: opts.label, lastName: null,
    publicMetadata: {}, privateMetadata: {}, unsafeMetadata: {}, createdAt: opts.createdAt, updatedAt: opts.createdAt,
  });
  await ctx.db.insert(s.clients).values({
    id: clientId, tokenHash: `hash_${opts.label}`, tokenIssuedAt: opts.createdAt, lastActiveSessionId: sessionId,
    ip: null, userAgent: "test", createdAt: opts.createdAt, updatedAt: opts.createdAt,
  });
  await ctx.db.insert(s.sessions).values({
    id: sessionId, clientId, userId, status: opts.status, lastActiveAt: opts.createdAt, lastActiveOrganizationId: null,
    expireAt: opts.expireAt, abandonAt: opts.expireAt, actor: null, firstFactorVerifiedAt: opts.createdAt,
    secondFactorVerifiedAt: null, ip: null, userAgent: "test", city: null, country: null,
    createdAt: opts.createdAt, updatedAt: opts.createdAt,
  });
  return sessionId;
}

describe("settings migration", () => {
  afterEach(() => vi.useRealTimers());

  it("converts legacy defaults, rescues sessions they expired, and keeps custom values", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.UTC(2026, 0, 1);
    vi.setSystemTime(start);
    const target = persistentTarget();
    try {
      const first = await open(target);
      // Exactly the tree an old release wrote: whole settings with its then-defaults, and no version marker.
      const legacy = defaultInstanceSettings();
      legacy.session.lifetimeSeconds = 7 * 24 * 60 * 60;
      legacy.session.multiSession = false;
      legacy.password.signOutOfOtherSessionsOnChange = true;
      legacy.anonymous.retentionSeconds = 30 * 24 * 60 * 60;
      await first.db.update(s.instance).set({ settings: legacy as unknown as Record<string, unknown> }).where(eq(s.instance.id, "default"));

      const active = await seedSession(first, { status: "active", expireAt: start + 7 * DAY, createdAt: start, label: "active" });
      const pending = await seedSession(first, { status: "pending", expireAt: start + 7 * DAY, createdAt: start, label: "pending" });
      // Already ended by the old release's sweeper (or by a deliberate MFA guard/revocation): must stay dead.
      const swept = await seedSession(first, { status: "expired", expireAt: start + 7 * DAY, createdAt: start, label: "swept" });
      const sweptPending = await seedSession(first, { status: "expired", expireAt: start + 7 * DAY, createdAt: start, label: "swept-pending" });
      const revoked = await seedSession(first, { status: "revoked", expireAt: start + 7 * DAY, createdAt: start, label: "revoked" });
      const ended = await seedSession(first, { status: "ended", expireAt: start + 7 * DAY, createdAt: start, label: "ended" });
      // A session the operator deliberately capped at an hour is not part of the old default and must not change.
      const short = await seedSession(first, { status: "active", expireAt: start + 3_600_000, createdAt: start, label: "short" });
      await first.close();

      vi.setSystemTime(start + 8 * DAY);
      const second = await open(target);

      expect(second.settings.get().session).toMatchObject({ lifetimeSeconds: 0, inactivityTimeoutSeconds: 0, multiSession: true });
      expect(second.settings.get().password).toMatchObject({ signOutOfOtherSessionsOnChange: false, signOutOfOtherSessionsOnReset: true });
      // Guest retention is opt-in now, including on upgraded installs.
      expect(second.settings.get().anonymous.retentionSeconds).toBe(0);

      const rows = await second.db.select().from(s.sessions);
      const byId = new Map(rows.map((row) => [row.id, row]));
      // Open rows whose deadline was written by the old default get the unlimited sentinel, status preserved.
      expect(byId.get(active)!.expireAt).toBe(SESSION_NEVER_EXPIRES_AT);
      expect(byId.get(active)!.status).toBe("active");
      expect(byId.get(pending)!.expireAt).toBe(SESSION_NEVER_EXPIRES_AT);
      expect(byId.get(pending)!.status).toBe("pending");
      // Rows already ended stay ended (and keep their old deadline): the upgrade never resurrects a session.
      for (const id of [swept, sweptPending, revoked, ended]) {
        expect(byId.get(id)!.expireAt).toBe(start + 7 * DAY);
      }
      expect(byId.get(swept)!.status).toBe("expired");
      // A pending-MFA session the old sweeper expired stays expired: flipping it back would bypass MFA enrolment.
      expect(byId.get(sweptPending)!.status).toBe("expired");
      expect(byId.get(revoked)!.status).toBe("revoked");
      expect(byId.get(ended)!.status).toBe("ended");
      expect(byId.get(short)!.expireAt).toBe(start + 3_600_000);

      // The migrated tree is persisted with its version, so the next boot is a no-op.
      const instance = (await second.db.select().from(s.instance).where(eq(s.instance.id, "default")))[0]!;
      expect((instance.settings as Record<string, unknown>)[SETTINGS_VERSION_KEY]).toBe(CURRENT_SETTINGS_VERSION);
      await second.close();
    } finally {
      target.cleanup();
    }
  });

  it("keeps a custom lifetime that differs from the old default", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 0, 1));
    const target = persistentTarget();
    try {
      const first = await open(target);
      const custom = defaultInstanceSettings();
      custom.session.lifetimeSeconds = 3_600;
      custom.session.multiSession = true;
      await first.db.update(s.instance).set({ settings: custom as unknown as Record<string, unknown> }).where(eq(s.instance.id, "default"));
      await first.close();

      const second = await open(target);
      expect(second.settings.get().session.lifetimeSeconds).toBe(3_600);
      await second.close();
    } finally {
      target.cleanup();
    }
  });

  it("writes the version marker last, so a crash between rescue and persistence re-runs the idempotent rewrite", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.UTC(2026, 0, 1);
    vi.setSystemTime(start);
    const target = persistentTarget();
    try {
      const first = await open(target);
      const legacy = defaultInstanceSettings();
      legacy.session.lifetimeSeconds = 7 * 24 * 60 * 60;
      await first.db.update(s.instance).set({ settings: legacy as unknown as Record<string, unknown> }).where(eq(s.instance.id, "default"));
      const active = await seedSession(first, { status: "active", expireAt: start + 7 * DAY, createdAt: start, label: "crash-active" });
      const revoked = await seedSession(first, { status: "revoked", expireAt: start + 7 * DAY, createdAt: start, label: "crash-revoked" });
      await first.close();

      // Simulate a process death after the session rewrite but before the version marker is written.
      const handle = await createDb(target.databaseUrl);
      await expect(createSettingsStore(handle.db, {
        encryptionKey: ENCRYPTION_KEY,
        nodeEnv: "test",
        upgradeHooks: { afterSessionRewrite: () => { throw new Error("process died before persisting the version"); } },
      })).rejects.toThrow(/process died/);
      const duringCrash = (await handle.db.select().from(s.instance).where(eq(s.instance.id, "default")))[0]!;
      expect((duringCrash.settings as Record<string, unknown>)[SETTINGS_VERSION_KEY]).toBeUndefined();
      expect((await handle.db.select().from(s.sessions).where(eq(s.sessions.id, active)))[0]!.expireAt).toBe(SESSION_NEVER_EXPIRES_AT);
      await handle.close();

      // The next boot re-runs the same migration; the rewrite is idempotent and the marker is finally committed.
      const second = await open(target);
      const rows = await second.db.select().from(s.sessions);
      const byId = new Map(rows.map((row) => [row.id, row]));
      expect(byId.get(active)!.expireAt).toBe(SESSION_NEVER_EXPIRES_AT);
      expect(byId.get(revoked)!.status).toBe("revoked");
      const instance = (await second.db.select().from(s.instance).where(eq(s.instance.id, "default")))[0]!;
      expect((instance.settings as Record<string, unknown>)[SETTINGS_VERSION_KEY]).toBe(CURRENT_SETTINGS_VERSION);
      await second.close();
    } finally {
      target.cleanup();
    }
  });
});
