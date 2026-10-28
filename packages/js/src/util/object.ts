/** Canonical plain-object guard for this package (untrusted JSON boundary). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readString(record: Record<string, unknown>, key: string, fallback = ""): string {
  const value = record[key];
  return typeof value === "string" ? value : fallback;
}

export function readNumber(record: Record<string, unknown>, key: string, fallback = 0): number {
  const value = record[key];
  return typeof value === "number" ? value : fallback;
}
