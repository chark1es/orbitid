// Upgrade safety: applying the OAuth-application migrations to a populated database must not delete grants,
// consents or sessions. SQLite used to rebuild `oauth_applications` with DROP/RENAME, which cascaded into every
// referencing table because the migrator runs inside a transaction where `PRAGMA foreign_keys=OFF` is ignored.
import { afterEach, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { eq, sql } from "drizzle-orm";
import { ID_PREFIX } from "@orbitid/shared";
import { createDb, dialect, type DbHandle } from "../../src/db";
import * as s from "../../src/db/schema";
import { newId } from "../../src/lib/ids";

const migrationsRoot = resolve(fileURLToPath(new URL("../../drizzle", import.meta.url)));
const previousThrough = dialect === "sqlite" ? 8 : 6;

async function copyMigrationsThroughPrevious(): Promise<{ folder: string; cleanup: () => void }> {
  const folder = mkdtempSync(join(tmpdir(), "orbitid-migrate-"));
  cpSync(join(migrationsRoot, dialect), folder, { recursive: true });
  const journalPath = join(folder, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx <= previousThrough);
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  return { folder, cleanup: () => rmSync(folder, { recursive: true, force: true }) };
}

async function migrateWith(handle: DbHandle, folder: string) {
  if (handle.driver === "sqlite") {
    const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
    migrate(handle.db as never, { migrationsFolder: folder });
  } else {
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    await migrate(handle.db as never, { migrationsFolder: folder });
  }
}

/** Raw SQL is used for tables whose *current* schema has columns this old revision does not have yet. */
async function runSql(handle: DbHandle, text: string) {
  const statement = sql.raw(text);
  if (handle.driver === "sqlite") (handle.db as unknown as { run(query: unknown): unknown }).run(statement);
  else await handle.db.execute(statement);
}

describe("database upgrades", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

  it("keeps applications, grants, consents and sessions when the OAuth-application migration is applied", async () => {
    // A private, unmigrated database of this suite's dialect: pglite for Postgres (the ephemeral provider hands out
    // an already-migrated template) and a plain SQLite memory database otherwise.
    const handle = await createDb(dialect === "postgres" ? "pglite://memory" : ":memory:");
    const old = await copyMigrationsThroughPrevious();
    cleanups.push(old.cleanup);

    await migrateWith(handle, old.folder);
    const now = Date.now();
    const appId = newId(ID_PREFIX.oauthApp);
    const userId = newId(ID_PREFIX.user);
    const clientId = newId(ID_PREFIX.client);
    const sessionId = newId(ID_PREFIX.session);

    await handle.db.insert(s.users).values({
      id: userId, username: null, usernameLower: null, firstName: "Ada", lastName: "Lovelace",
      publicMetadata: {}, privateMetadata: {}, unsafeMetadata: {}, createdAt: now, updatedAt: now,
    });
    // Raw insert: the current schema has columns (and runtime defaults) this old revision does not have yet.
    const bool = dialect === "sqlite" ? "0" : "false";
    const redirectUris = dialect === "sqlite" ? "'[]'" : "'[]'::jsonb";
    const insertApp = sql.raw(
      `INSERT INTO oauth_applications (id, name, client_id, client_secret_hash, is_public, redirect_uris, scopes, consent_screen_enabled, pkce_required, created_at, updated_at) ` +
      `VALUES ('${appId}', 'Existing app', '${newId(ID_PREFIX.oauthApp)}', NULL, ${bool}, ${redirectUris}, 'openid profile email', ${bool}, ${bool}, ${now}, ${now})`,
    );
    // Gated raw writes return a promise on SQLite as well: await it so ordering does not depend on the queue.
    if (handle.driver === "sqlite") await (handle.db as unknown as { run(query: unknown): unknown }).run(insertApp);
    else await handle.db.execute(insertApp);
    await runSql(handle,
      `INSERT INTO clients (id, token_hash, last_active_session_id, ip, user_agent, created_at, updated_at) ` +
      `VALUES ('${clientId}', 'hash_${now}', '${sessionId}', NULL, 'test', ${now}, ${now})`,
    );
    await handle.db.insert(s.sessions).values({
      id: sessionId, clientId, userId, status: "active", lastActiveAt: now, lastActiveOrganizationId: null,
      expireAt: now + 86_400_000, abandonAt: now + 86_400_000, actor: null, firstFactorVerifiedAt: now,
      secondFactorVerifiedAt: null, ip: null, userAgent: "test", city: null, country: null, createdAt: now, updatedAt: now,
    });
    await runSql(handle,
      `INSERT INTO oauth_grants (id, kind, application_id, user_id, token_hash, scopes, redirect_uri, code_challenge, code_challenge_method, nonce, family_id, session_id, revoked, expires_at, created_at) ` +
      `VALUES ('${newId(ID_PREFIX.oauthGrant)}', 'access', '${appId}', '${userId}', 'g1_${now}', 'openid', NULL, NULL, NULL, NULL, 'family_upgrade', '${sessionId}', ${bool}, ${now + 3_600_000}, ${now})`,
    );
    await runSql(handle,
      `INSERT INTO oauth_grants (id, kind, application_id, user_id, token_hash, scopes, redirect_uri, code_challenge, code_challenge_method, nonce, family_id, session_id, revoked, expires_at, created_at) ` +
      `VALUES ('${newId(ID_PREFIX.oauthGrant)}', 'refresh', '${appId}', '${userId}', 'g2_${now}', 'openid offline_access', NULL, NULL, NULL, NULL, 'family_upgrade', '${sessionId}', ${bool}, ${now + 86_400_000}, ${now})`,
    );
    await handle.db.insert(s.oauthConsents).values({ applicationId: appId, userId, scopes: "openid profile", createdAt: now });

    // The real upgrade path.
    await migrateWith(handle, join(migrationsRoot, dialect));

    const apps = await handle.db.select().from(s.oauthApplications).where(eq(s.oauthApplications.id, appId));
    const grants = await handle.db.select().from(s.oauthGrants).where(eq(s.oauthGrants.applicationId, appId));
    const consents = await handle.db.select().from(s.oauthConsents).where(eq(s.oauthConsents.applicationId, appId));
    const sessions = await handle.db.select().from(s.sessions).where(eq(s.sessions.id, sessionId));

    expect(apps).toHaveLength(1);
    expect(grants).toHaveLength(2);
    expect(consents).toHaveLength(1);
    expect(sessions).toHaveLength(1);
    // New columns exist with their defaults; old scopes were preserved and the base scopes they effectively used
    // were recorded explicitly (scope allowlists are enforced from this release on).
    expect(apps[0]!.postLogoutRedirectUris).toEqual([]);
    expect(apps[0]!.groupsClaim).toBe("all");
    expect(apps[0]!.accessTokenLifetimeSeconds).toBe(3600);
    expect(apps[0]!.scopes.split(/\s+/)).toEqual(expect.arrayContaining(["openid", "profile", "email", "groups", "offline_access"]));
    await handle.close();
  });
});
