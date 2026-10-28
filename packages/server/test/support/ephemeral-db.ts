import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll } from "vitest";
import { setEphemeralPostgres } from "../../src/db";

const adminUrl = process.env.ORBITID_TEST_PG_ADMIN_URL;
const created = new Set<string>();

if (adminUrl) {
  const admin = postgres(adminUrl, { max: 2, onnotice: () => {} });
  const base = adminUrl.replace(/\/postgres$/, "");

  setEphemeralPostgres(async () => {
    const name = `t_${randomBytes(6).toString("hex")}`;
    // Copying a template needs the template to be idle; concurrent test files take turns.
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
    return { url: `${base}/${name}`, drop: async () => { created.delete(name); await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } };
  });

  // Tests rarely close their context; drop what is left when the file finishes.
  afterAll(async () => {
    for (const name of created) await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
    created.clear();
  });
}
