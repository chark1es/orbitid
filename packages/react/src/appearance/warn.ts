declare const process: { env: { NODE_ENV?: string } } | undefined;

const warned = new Set<string>();

/**
 * `console.warn` once per message, outside production. Bundlers replace `process.env.NODE_ENV`, so the check (and
 * the message) drop out of production builds.
 */
export function devWarn(message: string): void {
  if (typeof process !== "undefined" && process.env.NODE_ENV === "production") return;
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[orbitid] ${message}`);
}

/** Tests only: forget which messages were already shown. */
export function resetDevWarnings(): void {
  warned.clear();
}
