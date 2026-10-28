// SQLite <-> Postgres data transfer: round-trips through spawned CLI processes, because one process can
// only ever hold one dialect's schema. The side that is not the test's dialect is an embedded Postgres
// (see support/global-postgres.ts); without it these tests skip with a clear message.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodeTs as spawnNodeTs, lastJson, supportScript } from "./support/spawn-cli";

const EMBEDDED_POSTGRES_MISSING =
  "Embedded Postgres is unavailable (its binary did not start), so the cross-dialect transfer tests were skipped. " +
  "Set ORBITID_TEST_PG_ADMIN_URL to a reachable Postgres to run them.";

const API_SCRIPT = supportScript("transfer-api.ts");
const CLI = join(__dirname, "../src/cli.ts");

const ENCRYPTION_KEY = "transfer-test-encryption-key-0123456789";
const BASE_URL = "http://localhost:4000";

let pg: EmbeddedPostgres | undefined;
let adminUrl: string | undefined;
let pgAvailable = false;
const databases: string[] = [];
const tempDirs: string[] = [];

const isPostgres = (url: string) => /^(postgres(ql)?|pglite):/i.test(url);

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function startPostgres(): Promise<void> {
  if (process.env.ORBITID_TEST_PG_ADMIN_URL) {
    adminUrl = process.env.ORBITID_TEST_PG_ADMIN_URL;
    pgAvailable = true;
    return;
  }
  try {
    const { createServer } = await import("node:net");
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.listen(0, () => { const { port: free } = probe.address() as { port: number }; probe.close(() => resolve(free)); });
      probe.on("error", reject);
    });
    const dir = tempDir("orbitid-transfer-pg-");
    const server = new EmbeddedPostgres({
      databaseDir: dir, user: "orbit", password: "orbit", port, persistent: false,
      postgresFlags: ["-c", "max_connections=100", "-c", "fsync=off"],
      onLog: () => {}, onError: () => {},
    });
    await server.initialise();
    await server.start();
    pg = server;
    adminUrl = `postgres://orbit:orbit@localhost:${port}/postgres`;
    pgAvailable = true;
  } catch (error) {
    console.warn(`${EMBEDDED_POSTGRES_MISSING}\n${error instanceof Error ? error.message : error}`);
    pgAvailable = false;
  }
}

/** A fresh, migrated database on the embedded server. */
async function freshPostgresDatabase(): Promise<string> {
  if (!adminUrl) throw new Error(EMBEDDED_POSTGRES_MISSING);
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  const name = `t_transfer_${Math.random().toString(36).slice(2, 10)}`;
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end({ timeout: 5 }).catch(() => undefined);
  }
  databases.push(name);
  return adminUrl.replace(/\/postgres$/, `/${name}`);
}

/** A path-based SQLite database (a `:memory:` URL is per process and cannot be handed to children). */
function freshSqliteDatabase(name: string): string {
  return `sqlite:${join(tempDir("orbitid-transfer-sqlite-"), `${name}.db`)}`;
}

interface CliRun { status: number; stdout: string; stderr: string }

function envFor(url: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ORBITID_DATABASE_URL: url,
    ORBITID_DB_DIALECT: isPostgres(url) ? "postgres" : "sqlite",
    ORBITID_ENCRYPTION_KEY: ENCRYPTION_KEY,
    ORBITID_BASE_URL: BASE_URL,
    ORBITID_SECRET_KEY: "sk_test_testsecret",
    NODE_ENV: "test",
    ...extra,
  };
}

function cli(args: string[], env: NodeJS.ProcessEnv, input?: string): Promise<CliRun> {
  return spawnNodeTs(CLI, args, { env, input }).done;
}

/** Boots the CLI against `url` once, which applies every migration for that dialect. */
async function migrate(url: string): Promise<void> {
  const run = await cli(["migrate"], envFor(url));
  if (run.status !== 0) throw new Error(`migrate ${url} failed: ${run.stderr || run.stdout}`);
}

interface SeedResult {
  ok: boolean;
  error?: string;
  dialect: string;
  userId: string;
  inviteeUserId: string;
  organizationId: string;
  webhookEndpointId: string;
  webhookSecret: string;
  apiKeySecret: string;
  totpSecret: string;
  counts: Record<string, number>;
}

async function seed(url: string): Promise<SeedResult> {
  const run = await spawnNodeTs(API_SCRIPT, [], {
    env: envFor(url),
    input: JSON.stringify({
      mode: "seed", databaseUrl: url, baseUrl: BASE_URL,
      email: "owner@transfer.test", inviteeEmail: "invitee@transfer.test", password: "Sup3rSecret!",
      organizationName: "Transfer Co",
    }),
  }).done;
  const result = run.status === 0 ? lastJson<SeedResult>(run.stdout) : ({ ok: false, error: run.stderr || run.stdout } as SeedResult);
  if (!result.ok) throw new Error(`seeding ${url} failed: ${result.error ?? "unknown error"}`);
  return result;
}

interface VerifyResult {
  ok: boolean;
  error?: string;
  dialect: string;
  passwordVerified: boolean;
  digestVerifies: boolean;
  totpCodeAccepted: boolean;
  userIdMatches: boolean;
  inOrganization: boolean | null;
  apiKeyVerifies: boolean;
  webhookSecretMatches: boolean;
  signingKeyReadable: boolean;
  counts: Record<string, number>;
}

async function verify(url: string, seeded: SeedResult): Promise<VerifyResult> {
  const run = await spawnNodeTs(API_SCRIPT, [], {
    env: envFor(url),
    input: JSON.stringify({
      mode: "verify", databaseUrl: url, baseUrl: BASE_URL, email: "owner@transfer.test", password: "Sup3rSecret!",
      organizationId: seeded.organizationId, apiKeySecret: seeded.apiKeySecret,
      webhookEndpointId: seeded.webhookEndpointId, webhookSecret: seeded.webhookSecret,
    }),
  }).done;
  const result = run.status === 0 ? lastJson<VerifyResult>(run.stdout) : ({ ok: false, error: run.stderr || run.stdout } as VerifyResult);
  if (!result.ok) throw new Error(`verifying ${url} failed: ${result.error ?? "unknown error"}`);
  return result;
}

/** Counts that must survive a move, compared table by table on both sides. */
const MIGRATED_TABLES = [
  "users", "emailAddresses", "clients", "sessions", "organizations", "organizationMemberships", "organizationInvitations",
  "invitations", "webhookEndpoints", "webhookEvents", "webhookDeliveries", "apiKeys", "oauthApplications", "signingKeys", "auditLogs",
];

/** Schema property name -> database table name, for matching CLI output. */
const DATABASE_TABLE_NAME: Record<string, string> = {
  emailAddresses: "email_addresses", organizationMemberships: "organization_memberships",
  organizationInvitations: "organization_invitations", webhookEndpoints: "webhook_endpoints",
  webhookEvents: "webhook_events", webhookDeliveries: "webhook_deliveries", apiKeys: "api_keys",
  oauthApplications: "oauth_applications", signingKeys: "signing_keys", auditLogs: "audit_logs",
  users: "users", clients: "clients", sessions: "sessions", organizations: "organizations", invitations: "invitations",
};

beforeAll(async () => {
  await startPostgres();
}, 120_000);

afterAll(async () => {
  if (pg) {
    await pg.stop().catch(() => undefined);
    pg = undefined;
  }
  if (adminUrl && databases.length) {
    const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
    for (const name of databases) await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
    await admin.end({ timeout: 5 }).catch(() => undefined);
  }
  databases.length = 0;
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
}, 120_000);

describe("database transfer", () => {
  it("derives a foreign-key-safe table order and leaves ephemeral tables out", async () => {
    const { tableOrder, SKIPPED_TABLES } = await import("../src/services/transfer");
    const order = tableOrder();
    const names = order.map((entry) => entry.name);
    const position = new Map(names.map((name, index) => [name, index]));
    expect(SKIPPED_TABLES.has("rateLimits")).toBe(true);
    expect(names).not.toContain("rate_limits");
    for (const emitted of ["users", "organizations", "organization_memberships", "organization_invitations", "webhook_endpoints", "webhook_events", "webhook_deliveries", "audit_logs", "api_keys", "oauth_applications"]) {
      expect(names).toContain(emitted);
    }
    // Every table that references another is listed after it.
    const { getTableConfig } = await import("drizzle-orm/sqlite-core");
    for (const entry of order) {
      const config = getTableConfig(entry.table as never);
      for (const fk of config.foreignKeys) {
        const reference = fk.reference();
        const parent = getTableConfig(reference.foreignTable as never).name;
        if (parent === entry.name || !position.has(parent)) continue;
        expect(position.get(parent)!, `${parent} must come before ${entry.name}`).toBeLessThan(position.get(entry.name)!);
      }
    }
    expect(names[0]).toBe("instance");
  });

  it("round-trips SQLite -> Postgres -> SQLite with data created through the API", async (context) => {
    if (!pgAvailable) {
      console.warn(EMBEDDED_POSTGRES_MISSING);
      context.skip();
      return;
    }

    const sqliteUrl = freshSqliteDatabase("source");
    await migrate(sqliteUrl);
    const pgUrl = await freshPostgresDatabase();
    await migrate(pgUrl);

    const source = await seed(sqliteUrl);
    expect(source.dialect).toBe("sqlite");

    // Export is plain JSON Lines: a header, then one portable row per line.
    const exported = await cli(["export", "--out", "-"], envFor(sqliteUrl));
    expect(exported.status, exported.stderr).toBe(0);
    const lines = exported.stdout.trim().split("\n");
    const header = JSON.parse(lines[0]!) as { orbitid_export: number; dialect: string; tables: string[]; key_check: string; schema_version: string };
    expect(header.orbitid_export).toBe(1);
    expect(header.dialect).toBe("sqlite");
    expect(header.tables).toContain("users");
    expect(header.tables).toContain("webhook_deliveries");
    expect(header.tables).toContain("audit_logs");
    // Ephemeral counters describe the old process and are not copied.
    expect(header.tables).not.toContain("rate_limits");
    expect(typeof header.key_check).toBe("string");
    const userLine = lines.slice(1).map((line) => JSON.parse(line) as { t: string; r: Record<string, unknown> }).find((line) => line.t === "users");
    expect(userLine).toBeTruthy();
    expect(typeof userLine!.r.created_at).toBe("number");

    const imported = await cli(["import", "--in", "-"], envFor(pgUrl), exported.stdout);
    expect(imported.status, imported.stderr).toBe(0);
    const summary = lastJson<{ orbitid_import: number; ok: boolean; counts: { table: string; target: number; ok: boolean }[] }>(imported.stdout);
    expect(summary.ok).toBe(true);
    expect(summary.counts.every((item) => item.ok)).toBe(true);

    // The migrated instance works: password, TOTP secret, API key, webhook secret, membership.
    const onPostgres = await verify(pgUrl, source);
    expect(onPostgres.dialect).toBe("postgres");
    expect(onPostgres.digestVerifies).toBe(true);
    expect(onPostgres.passwordVerified).toBe(true);
    expect(onPostgres.totpCodeAccepted).toBe(true);
    expect(onPostgres.userIdMatches).toBe(true);
    expect(onPostgres.inOrganization).toBe(true);
    expect(onPostgres.apiKeyVerifies).toBe(true);
    expect(onPostgres.webhookSecretMatches).toBe(true);
    expect(onPostgres.signingKeyReadable).toBe(true);
    for (const table of MIGRATED_TABLES) expect(onPostgres.counts[table], `${table} after SQLite -> Postgres`).toBe(source.counts[table]);

    // And back: Postgres -> SQLite through `copy`, which runs export and import in separate processes.
    const backUrl = freshSqliteDatabase("target");
    await migrate(backUrl);
    const copied = await cli(["copy", "--from", pgUrl, "--to", backUrl], envFor(":memory:"));
    expect(copied.status, copied.stderr).toBe(0);
    const copiedSummary = lastJson<{ counts: { table: string; imported: number; target: number; ok: boolean }[] }>(copied.stdout);
    expect(copiedSummary.counts.every((item) => item.ok)).toBe(true);
    // Progress must never leak database credentials.
    expect(copied.stdout).not.toContain("orbit:orbit@");
    expect(copied.stderr).not.toContain("orbit:orbit@");

    const backOnSqlite = await verify(backUrl, source);
    expect(backOnSqlite.dialect).toBe("sqlite");
    expect(backOnSqlite.digestVerifies).toBe(true);
    expect(backOnSqlite.passwordVerified).toBe(true);
    expect(backOnSqlite.totpCodeAccepted).toBe(true);
    expect(backOnSqlite.userIdMatches).toBe(true);
    expect(backOnSqlite.inOrganization).toBe(true);
    expect(backOnSqlite.apiKeyVerifies).toBe(true);
    // Signing in against the Postgres instance added clients, sessions and webhook events there after the
    // source was seeded, so the copy moves more than the original export. Compare the destination with what
    // the copy reported, and the stable tables with the original source.
    const moved = new Map(copiedSummary.counts.map((item) => [item.table, item.target]));
    for (const table of MIGRATED_TABLES) expect(backOnSqlite.counts[table], `${table} after Postgres -> SQLite`).toBe(moved.get(DATABASE_TABLE_NAME[table]!));
    for (const table of ["users", "organizations", "organizationMemberships", "organizationInvitations", "invitations", "apiKeys", "oauthApplications", "signingKeys"]) {
      expect(backOnSqlite.counts[table], `${table} unchanged by Postgres -> SQLite`).toBe(source.counts[table]);
    }
  }, 240_000);

  it("pages large tables on the primary key without dropping or repeating rows", async () => {
    const hostUrl = freshSqliteDatabase("bulk");
    await migrate(hostUrl);
    const bulk = await spawnNodeTs(supportScript("transfer-bulk.ts"), [], { env: envFor(hostUrl) }).done;
    expect(bulk.status, bulk.stderr).toBe(0);

    const exported = await cli(["export", "--out", "-"], envFor(hostUrl));
    expect(exported.status, exported.stderr).toBe(0);
    const parsed = exported.stdout.trim().split("\n").map((line) => JSON.parse(line) as { t?: string; r?: Record<string, unknown> });
    const userRows = parsed.filter((line) => line.t === "users");
    expect(userRows).toHaveLength(1_200);
    expect(userRows.map((row) => row.r!.id)).toEqual(Array.from({ length: 1_200 }, (_, index) => `user_bulk_${String(index).padStart(5, "0")}`));
    const sample = userRows[7]!.r!;
    expect(typeof sample.created_at).toBe("number");
    expect(sample.banned).toBe(false);
    expect(sample.public_metadata).toEqual({ index: 7, nested: { even: false } });
    // Nothing dialect-specific: no marshalled buffers, no wrapped date objects.
    expect(exported.stdout).not.toContain("Buffer");
    expect(exported.stdout).not.toContain('"$type"');
  }, 180_000);

  it("refuses a populated target unless --truncate --yes is given", async () => {
    const sourceUrl = freshSqliteDatabase("guard-source");
    const targetUrl = freshSqliteDatabase("guard-target");
    await migrate(sourceUrl);
    await migrate(targetUrl);

    const source = await seed(sourceUrl);
    const exported = await cli(["export", "--out", "-"], envFor(sourceUrl));
    expect(exported.status, exported.stderr).toBe(0);

    // The target only has its bootstrap rows, so the first import is allowed.
    const first = await cli(["import", "--in", "-"], envFor(targetUrl), exported.stdout);
    expect(first.status, first.stderr).toBe(0);

    // A second import refuses and leaves the data alone.
    const refused = await cli(["import", "--in", "-"], envFor(targetUrl), exported.stdout);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("already contains data");
    expect(refused.stderr).toContain("--truncate");
    const stillThere = await cli(["export", "--out", "-"], envFor(targetUrl));
    expect(stillThere.stdout).toContain(source.userId);

    // --truncate alone is not enough.
    const unconfirmed = await cli(["import", "--in", "-", "--truncate"], envFor(targetUrl), exported.stdout);
    expect(unconfirmed.status).not.toBe(0);
    expect(unconfirmed.stderr).toContain("--yes");

    // --truncate --yes replaces instead of colliding with existing keys.
    const replaced = await cli(["import", "--in", "-", "--truncate", "--yes"], envFor(targetUrl), exported.stdout);
    expect(replaced.status, replaced.stderr).toBe(0);
    const counts = lastJson<{ counts: { table: string; target: number; ok: boolean }[] }>(replaced.stdout);
    expect(counts.counts.every((item) => item.ok)).toBe(true);
    expect(counts.counts.find((item) => item.table === "users")!.target).toBe(source.counts.users);
  }, 180_000);

  it("fails before writing anything when the encryption key differs", async () => {
    const sourceUrl = freshSqliteDatabase("key-source");
    const targetUrl = freshSqliteDatabase("key-target");
    await migrate(sourceUrl);
    await migrate(targetUrl);

    await seed(sourceUrl);
    const exported = await cli(["export", "--out", "-"], envFor(sourceUrl));
    expect(exported.status, exported.stderr).toBe(0);

    const wrongKey = await cli(["import", "--in", "-"], envFor(targetUrl, { ORBITID_ENCRYPTION_KEY: "a-completely-different-key-0123456789" }), exported.stdout);
    expect(wrongKey.status).not.toBe(0);
    expect(wrongKey.stderr).toContain("different ORBITID_ENCRYPTION_KEY");
    const target = await cli(["export", "--out", "-"], envFor(targetUrl));
    expect(target.stdout.split("\n").some((line) => line.startsWith('{"t":"users"'))).toBe(false);
  }, 180_000);

  it("reports a failed copy without crashing on the closed pipe", async () => {
    const sourceUrl = freshSqliteDatabase("pipe-source");
    const targetUrl = freshSqliteDatabase("pipe-target");
    await migrate(sourceUrl);
    await migrate(targetUrl);
    await spawnNodeTs(supportScript("transfer-bulk.ts"), [], { env: envFor(sourceUrl) }).done;
    await spawnNodeTs(supportScript("transfer-bulk.ts"), [], { env: envFor(targetUrl) }).done;

    // The target already holds rows, so the import exits after the header while the export is still
    // writing. The copy must report the import's error, not die on the broken pipe.
    const copied = await cli(["copy", "--from", sourceUrl, "--to", targetUrl], envFor(":memory:"));
    expect(copied.status).not.toBe(0);
    expect(copied.stderr).toContain("already contains data");
    expect(copied.stdout + copied.stderr).not.toContain("EPIPE");
  }, 180_000);

  it("rejects a malformed header and a row count mismatch", async () => {
    const targetUrl = freshSqliteDatabase("bad-target");
    await migrate(targetUrl);

    const notAnExport = await cli(["import", "--in", "-"], envFor(targetUrl), '{"hello":"world"}\n');
    expect(notAnExport.status).not.toBe(0);
    expect(notAnExport.stderr).toContain("Invalid export header");

    const sourceUrl = freshSqliteDatabase("bad-source");
    await migrate(sourceUrl);
    await seed(sourceUrl);
    const exported = await cli(["export", "--out", "-"], envFor(sourceUrl));
    const lines = exported.stdout.trim().split("\n");
    // Drop a row the header promised (an audit log has no children, so the import itself still succeeds):
    // the final per-table verification must notice and exit non-zero.
    const auditLines = lines.slice(1).filter((line) => line.startsWith('{"t":"audit_logs"'));
    expect(auditLines.length).toBeGreaterThan(0);
    const missingRow = [lines[0]!, ...lines.slice(1).filter((line) => line !== auditLines[0])].join("\n") + "\n";
    const mismatch = await cli(["import", "--in", "-"], envFor(targetUrl), missingRow);
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.stderr).toContain("Row count verification failed");
    expect(mismatch.stderr).toContain("audit_logs");
  }, 180_000);
});
