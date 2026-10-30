/** Imported hashes are untrusted work-factor instructions. Bound them before any expensive verifier runs. */
export type DigestKind = "argon2" | "bcrypt" | "scrypt";
export const MAX_DIGEST_LENGTH = 1024;
const base64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

export function parseScryptDigest(digest: string) {
  const parts = digest.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt" || !parts.slice(1, 4).every((part) => /^\d+$/.test(part))) return null;
  const [N, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  if (!Number.isSafeInteger(N) || N < 2 || N > 65536 || (N & (N - 1)) !== 0 || r < 1 || r > 16 || p < 1 || p > 4) return null;
  if (128 * N * r > 128 * 1024 * 1024 || N * r * p > 2097152) return null;
  if (!base64.test(parts[4]!) || !base64.test(parts[5]!)) return null;
  const salt = Buffer.from(parts[4]!, "base64"), expected = Buffer.from(parts[5]!, "base64");
  if (salt.length < 8 || salt.length > 64 || expected.length < 16 || expected.length > 64) return null;
  return { N, r, p, salt, expected };
}

export function passwordDigestKind(digest: string): DigestKind | null {
  if (!digest || digest.length > MAX_DIGEST_LENGTH) return null;
  if (digest.startsWith("scrypt$")) return parseScryptDigest(digest) ? "scrypt" : null;
  const bcrypt = digest.match(/^\$2[abxy]\$(\d{2})\$[./A-Za-z0-9]{53}$/);
  if (bcrypt) return Number(bcrypt[1]) >= 4 && Number(bcrypt[1]) <= 14 ? "bcrypt" : null;
  const argon = digest.match(/^\$argon2(?:id|i|d)\$v=(?:16|19)\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/);
  if (!argon) return null;
  const m = Number(argon[1]), t = Number(argon[2]), p = Number(argon[3]);
  if (m < 8 * p || m > 65536 || t < 1 || t > 8 || p < 1 || p > 4 || m * t > 262144) return null;
  if (Buffer.from(argon[4]!, "base64").length < 8 || Buffer.from(argon[5]!, "base64").length < 16) return null;
  return "argon2";
}
