import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import EmbeddedPostgres from "embedded-postgres";
import postgres from "postgres";

const freePort = () => new Promise<number>((resolve, reject) => {
  const srv = createServer();
  srv.listen(0, () => { const { port } = srv.address() as { port: number }; srv.close(() => resolve(port)); });
  srv.on("error", reject);
});

/**
 * Starts one real Postgres for the whole run (only when ORBITID_DB_DIALECT=postgres) and migrates a
 * template database. Each test context then copies the template, which takes milliseconds.
 */
export default async function setup() {
  if (process.env.ORBITID_DB_DIALECT !== "postgres") return;
  if (process.env.ORBITID_TEST_PG_ADMIN_URL) return;
  const dir = mkdtempSync(join(tmpdir(), "orbitid-pg-"));
  const port = await freePort();
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: "orbit", password: "orbit", port, persistent: false, postgresFlags: ["-c", "max_connections=2000", "-c", "fsync=off"], onLog: () => {}, onError: () => {} });
  await pg.initialise();
  await pg.start();
  const admin = `postgres://orbit:orbit@localhost:${port}`;
  await pg.createDatabase("orbit_template");

  const { createDb, runMigrations } = await import("../../src/db");
  const template = await createDb(`${admin}/orbit_template`);
  await runMigrations(template);
  await template.close();

  process.env.ORBITID_TEST_PG_ADMIN_URL = `${admin}/postgres`;
  return async () => {
    await pg.stop();
    rmSync(dir, { recursive: true, force: true });
  };
}

export { postgres };
