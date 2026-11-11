import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll } from "vitest";
import { setEphemeralPostgres } from "../../src/db";

const adminUrl = process.env.ORBITID_TEST_PG_ADMIN_URL;
const created = new Set<string>();
let admin: ReturnType<typeof postgres> | undefined;

if (adminUrl) {
  admin = postgres(adminUrl, { max: 2, onnotice: () => {} });
  const client = admin;
  const base = adminUrl.replace(/\/postgres$/, "");

  const createDatabase = async () => {
    const name = `t_${randomBytes(6).toString("hex")}`;
    // Copying a template needs the template to be idle; concurrent test files take turns.
    for (let attempt = 0; ; attempt++) {
      try {
        await client.unsafe(`CREATE DATABASE ${name} TEMPLATE orbit_template`);
        break;
      } catch (error) {
        if (attempt > 40) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25 + Math.random() * 75));
      }
    }
    created.add(name);
    return { url: `${base}/${name}`, drop: async () => { created.delete(name); await client.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } };
  };

  setEphemeralPostgres(createDatabase);

  // Tests rarely close their context; drop what is left when the file finishes.
  afterAll(async () => {
    for (const name of created) await client.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
    created.clear();
  });
}

/**
 * A second, isolated Postgres database that a test can open more than one connection to (for a real concurrency
 * barrier). SQLite tests use a temporary file instead, so this helper is Postgres-only.
 */
export async function createDedicatedPostgresDatabase(): Promise<{ url: string; drop(): Promise<void> }> {
  if (!adminUrl || !admin) throw new Error("createDedicatedPostgresDatabase needs the Postgres test suite (ORBITID_TEST_PG_ADMIN_URL)");
  const name = `t_${randomBytes(6).toString("hex")}`;
  for (let attempt = 0; ; attempt++) {
    try {
      await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE orbit_template`);
      break;
    } catch (error) {
      if (attempt > 40) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 + Math.random() * 75));
    }
  }
  created.add(name);
  const base = adminUrl.replace(/\/postgres$/, "");
  return { url: `${base}/${name}`, drop: async () => { created.delete(name); await admin!.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } };
}
