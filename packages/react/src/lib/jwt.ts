/**
 * Decode a JWT payload without verifying it. React only needs the claims for
 * `useAuth()` projections (`org_role`, `fva`, `act`, …); the server verifies signatures.
 *
 * `atob` exists in browsers, jsdom and Node 20+, so no `Buffer` fallback is needed.
 */
export function decodeJwt<T = Record<string, unknown>>(token: string | null | undefined): T | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const base64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}
