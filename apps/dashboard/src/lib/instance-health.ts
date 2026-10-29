import { getApiUrl } from "./api";

export interface InstanceHealth {
  apiUrl: string;
  status: string;
  database: "postgres" | "sqlite" | null;
  publishableKey: string;
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** Public endpoint outside `/v1`. The server reports the database once that field ships. */
export async function fetchInstanceHealth(url: string = getApiUrl(), signal?: AbortSignal): Promise<InstanceHealth> {
  const apiUrl = normalizeUrl(url);
  const res = await fetch(`${apiUrl}/health`, { signal });
  if (!res.ok) throw new Error(`GET ${apiUrl}/health returned ${res.status}`);
  const body: unknown = await res.json().catch(() => null);
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const database = record.database;
  return {
    apiUrl,
    status: typeof record.status === "string" ? record.status : "unknown",
    database: database === "postgres" || database === "sqlite" ? database : null,
    publishableKey: typeof record.publishable_key === "string" ? record.publishable_key : "",
  };
}

export function databaseLabel(database: InstanceHealth["database"]): string {
  if (database === "postgres") return "Postgres";
  if (database === "sqlite") return "SQLite";
  return "Database unknown";
}
