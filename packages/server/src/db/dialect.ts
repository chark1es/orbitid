export type Dialect = "postgres" | "sqlite";

const POSTGRES_URL = /^(postgres(ql)?|pglite):/i;

/** Postgres when the database URL says so, otherwise SQLite. `ORBITID_DB_DIALECT` forces one (used by tests). */
export function detectDialect(env: NodeJS.ProcessEnv = process.env): Dialect {
  const forced = env.ORBITID_DB_DIALECT;
  if (forced === "postgres" || forced === "sqlite") return forced;
  return POSTGRES_URL.test(env.ORBITID_DATABASE_URL ?? env.DATABASE_URL ?? "") ? "postgres" : "sqlite";
}

export const isPostgresUrl = (url: string) => POSTGRES_URL.test(url);

/** Table objects are built once at import time, so the dialect is fixed for the life of the process. */
export const dialect: Dialect = detectDialect();
