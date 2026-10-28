import type { UserJSON } from "@orbitid/shared";

const numberFormat = new Intl.NumberFormat("en-US");
const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const dateTimeFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function formatNumber(value: number | null | undefined): string {
  return numberFormat.format(value ?? 0);
}

export function formatDate(ms: number | null | undefined): string {
  return ms ? dateFormat.format(ms) : "—";
}

export function formatDateTime(ms: number | null | undefined): string {
  return ms ? dateTimeFormat.format(ms) : "—";
}

export function formatRelativeTime(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return "—";
  const diff = now - ms;
  if (diff < 45_000) return "just now";
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return formatDate(ms);
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  const letters = parts.map((part) => part[0]?.toUpperCase() ?? "").join("");
  return letters || "?";
}

export function userDisplayName(
  user: Pick<UserJSON, "first_name" | "last_name" | "username"> | null | undefined,
): string {
  if (!user) return "Unknown user";
  return [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || "";
}

export function primaryEmail(user: UserJSON | null | undefined): string {
  if (!user) return "";
  const match = user.email_addresses.find((email) => email.id === user.primary_email_address_id);
  return (match ?? user.email_addresses[0])?.email_address ?? "";
}

export function userLabel(user: UserJSON | null | undefined): string {
  if (!user) return "Unknown user";
  return userDisplayName(user) || primaryEmail(user) || user.id;
}

export function percent(part: number, total: number): string {
  if (!total) return "0%";
  return `${Math.round((part / total) * 100)}%`;
}

export type JsonParseResult = { ok: true; value: unknown } | { ok: false; error: string };
export type JsonObjectParseResult = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

/** Empty input is treated as an empty object so untouched editors are always valid. */
export function parseJsonText(text: string): JsonParseResult {
  if (!text.trim()) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Invalid JSON" };
  }
}

export function parseJsonObject(text: string): JsonObjectParseResult {
  const parsed = parseJsonText(text);
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Expected a JSON object" };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

export function formatJsonText(text: string): string {
  const parsed = parseJsonText(text);
  return parsed.ok ? JSON.stringify(parsed.value, null, 2) : text;
}

export function stringifyMetadata(value: unknown): string {
  if (value === undefined || value === null) return "{}";
  if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) return "{}";
  return JSON.stringify(value, null, 2);
}
