import { defineConfig } from "drizzle-kit";

/** `ORBITID_DB_DIALECT=postgres|sqlite drizzle-kit generate` (see the db:generate scripts). */
const dialect = process.env.ORBITID_DB_DIALECT === "sqlite" ? "sqlite" : "postgresql";
export default defineConfig({
  dialect,
  schema: "./src/db/schema.ts",
  out: dialect === "sqlite" ? "./drizzle/sqlite" : "./drizzle/postgres",
});
