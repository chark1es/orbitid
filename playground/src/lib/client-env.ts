/**
 * Browser-safe instance lookup. `lib/env.ts` imports `next/headers`, so client components read the
 * inlined publishable key here instead and decode the Frontend API URL from it.
 */
export function frontendApiUrl(): string | null {
  const key = process.env.NEXT_PUBLIC_ORBITID_PUBLISHABLE_KEY?.trim();
  const match = key ? /^pk_(?:test|live)_([A-Za-z0-9_-]+)$/.exec(key) : null;
  if (match?.[1]) {
    try {
      const base64 = match[1].replace(/-/g, "+").replace(/_/g, "/");
      const decoded = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
      if (/^https?:\/\//.test(decoded)) return decoded.replace(/\/+$/, "");
    } catch {
      // Fall through to the explicit override.
    }
  }
  const explicit = process.env.NEXT_PUBLIC_ORBITID_API_URL?.trim();
  return explicit ? explicit.replace(/\/+$/, "") : null;
}
