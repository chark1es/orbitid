/**
 * The SDK's `Session` resource only copies the fields it knows, and `second_factor_skipped_by_trusted_device`
 * is not one of them. The Inspector therefore reads the raw Frontend API list, which still carries it.
 */
export interface RawSessionMarker {
  id?: unknown;
  status?: unknown;
  second_factor_skipped_by_trusted_device?: unknown;
}

export type SkipMarker = "skipped" | "not-skipped" | "unknown";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Sessions come back as `{ response: [...] }`; accept a bare array too. */
export function rawSessionsFrom(value: unknown): RawSessionMarker[] {
  if (Array.isArray(value)) return value.filter((item): item is RawSessionMarker => asRecord(item) !== null);
  const record = asRecord(value);
  const list = record?.response ?? record?.data;
  return Array.isArray(list) ? list.filter((item): item is RawSessionMarker => asRecord(item) !== null) : [];
}

/** `skipped` only for an explicit `true`, `unknown` when the session is not in the list at all. */
export function skipMarkerFor(sessions: RawSessionMarker[], sessionId: string | null | undefined): SkipMarker {
  if (!sessionId) return "unknown";
  const match = sessions.find((session) => session.id === sessionId);
  if (!match) return "unknown";
  return match.second_factor_skipped_by_trusted_device === true ? "skipped" : "not-skipped";
}
