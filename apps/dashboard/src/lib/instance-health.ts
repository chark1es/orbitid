import { getApiUrl } from "./api";

export interface InstanceHealth {
  apiUrl: string;
  status: string;
  database: "postgres" | "sqlite" | null;
  /** Driver name reported by newer servers; `postgres` for the Rust server. */
  databaseDriver: string | null;
  publishableKey: string;
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function databaseOf(value: unknown): InstanceHealth["database"] {
  // SQLite is accepted only so the dashboard can explain an older server; the current
  // server refuses to start without Postgres.
  return value === "postgres" || value === "sqlite" ? value : null;
}

/** Public endpoint outside `/v1`. */
export async function fetchInstanceHealth(url: string = getApiUrl(), signal?: AbortSignal): Promise<InstanceHealth> {
  const apiUrl = normalizeUrl(url);
  const res = await fetch(`${apiUrl}/health`, { signal });
  if (!res.ok) throw new Error(`GET ${apiUrl}/health returned ${res.status}`);
  const body: unknown = await res.json().catch(() => null);
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return {
    apiUrl,
    status: typeof record.status === "string" ? record.status : "unknown",
    database: databaseOf(record.database),
    databaseDriver: typeof record.database_driver === "string" ? record.database_driver : null,
    publishableKey: typeof record.publishable_key === "string" ? record.publishable_key : "",
  };
}

export function databaseLabel(database: InstanceHealth["database"]): string {
  if (database === "postgres") return "Postgres";
  if (database === "sqlite") return "SQLite";
  return "Database unknown";
}

/** True for an older TypeScript server still configured for SQLite. */
export function isLegacyDatabase(database: InstanceHealth["database"]): boolean {
  return database === "sqlite";
}

/** One sentence an operator can act on, or null when the database is the supported one. */
export function databaseSupportNote(database: InstanceHealth["database"], databaseDriver?: string | null): string | null {
  if (database === "sqlite") {
    return "This instance runs SQLite, which the current server no longer supports. Move it to Postgres before upgrading (docs/DATA_MOVE.md).";
  }
  if (database === "postgres" && databaseDriver && databaseDriver !== "postgres") {
    return `The server reports the "${databaseDriver}" driver. The current server expects Postgres.`;
  }
  return null;
}
