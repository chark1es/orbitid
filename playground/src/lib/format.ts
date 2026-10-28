const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Human duration for a number of seconds: `7 days`, `1 hour`, `45 minutes`, `30 seconds`. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "Unknown";
  const total = Math.max(0, Math.round(seconds));
  if (total === 0) return "0 seconds";
  const units: Array<[number, string]> = [
    [DAY, "day"],
    [HOUR, "hour"],
    [MINUTE, "minute"],
  ];
  for (const [size, name] of units) {
    if (total % size === 0) {
      const count = total / size;
      return `${count} ${name}${count === 1 ? "" : "s"}`;
    }
  }
  return `${total} second${total === 1 ? "" : "s"}`;
}

/** Clock time with seconds for tables. `14:02:31`. */
export function formatClock(value: number | string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Date and clock time, for rows that may come from another day. */
export function formatDateTime(value: number | string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
