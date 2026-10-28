import type { InstanceSettings } from "@orbitid/shared";
import { api } from "../../lib/api";
import { normalizeInstanceSettings } from "./settings";

export const SETTINGS_QUERY_KEY = ["instance"];

/** Normalize Backend API list responses: `{ data, total_count }`, bare arrays, or `{ response }`. */
export function unwrapList<T>(response: unknown): T[] {
  if (Array.isArray(response)) return response as T[];
  if (response && typeof response === "object") {
    const record = response as Record<string, unknown>;
    if (Array.isArray(record.data)) return record.data as T[];
    if (Array.isArray(record.response)) return record.response as T[];
  }
  return [];
}

export function unwrapTotal(response: unknown, fallback: number): number {
  if (response && typeof response === "object") {
    const record = response as Record<string, unknown>;
    if (typeof record.total_count === "number") return record.total_count;
    if (typeof record.totalCount === "number") return record.totalCount;
    if (typeof record.total === "number") return record.total;
  }
  return fallback;
}

export async function fetchInstanceSettings(): Promise<InstanceSettings> {
  return normalizeInstanceSettings(await api("GET", "/instance"));
}

/** Extract a one-time secret from create/rotate responses. */
export function oneTimeSecret(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  const record = response as Record<string, unknown>;
  for (const key of ["secret", "client_secret", "machine_secret", "token"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  if (record.data && typeof record.data === "object") return oneTimeSecret(record.data);
  return null;
}
