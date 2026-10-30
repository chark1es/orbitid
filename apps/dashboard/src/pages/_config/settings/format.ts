import { isPlainObject } from "./patch";

export function errorMessage(error: unknown): string {
  if (!error) return "";
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Something went wrong.";
}

export function parseJsonRecord(text: string): { value: Record<string, unknown>; error: null } | { value: null; error: string } {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isPlainObject(parsed)) return { value: null, error: "Expected a JSON object." };
    return { value: parsed, error: null };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : "Invalid JSON." };
  }
}

export function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return "{}";
  }
}

export function textToList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function listToText(values: readonly string[] | undefined): string {
  return (values ?? []).join(", ");
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.pathname === "/" && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function isValidDomain(value: string): boolean {
  const domain = value.trim().toLowerCase().replace(/^@/, "");
  return /^(?=.{1,253}$)(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/.test(domain);
}

export function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^@+/, "").replace(/\/.*$/, "");
}

export function normalizeRestrictionIdentifier(
  kind: "email" | "domain" | "phone",
  value: string,
): { identifier: string; identifier_type: "email_address" | "phone_number" } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (kind === "phone") {
    return { identifier: trimmed, identifier_type: "phone_number" };
  }
  if (kind === "domain") {
    const domain = normalizeDomain(trimmed);
    if (!isValidDomain(domain)) return null;
    return { identifier: `@${domain}`, identifier_type: "email_address" };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null;
  return { identifier: trimmed.toLowerCase(), identifier_type: "email_address" };
}

export function formatDate(timestamp: number | null | undefined): string {
  if (!timestamp) return "Not set";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "Not set";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function toDateInput(timestamp: number | null | undefined): string {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

export function fromDateInput(value: string): number | null {
  if (!value) return null;
  const parsed = new Date(`${value}T23:59:59.999`).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

export function fromDateInputStart(value: string): number | null {
  if (!value) return null;
  const parsed = new Date(`${value}T00:00:00.000`).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

export function humanDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "disabled";
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  if (seconds % 86_400 === 0) {
    const days = seconds / 86_400;
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  if (seconds % 3_600 === 0) {
    const hours = seconds / 3_600;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `${seconds} seconds`;
}

export function truncate(value: string, length = 48): string {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}
