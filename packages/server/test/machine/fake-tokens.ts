// Test double for `services/tokens`. A fixed in-process RS256 key proves minting + offline verification
// without depending on another worker's signing-key storage.
import { exportJWK, generateKeyPair, jwtVerify, SignJWT, type JWK } from "jose";

const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
export const TEST_KID = "test-key";

export const TEST_PUBLIC_JWK: JWK = { ...(await exportJWK(publicKey)), alg: "RS256", use: "sig", kid: TEST_KID };

export async function getJwks(_ctx: unknown): Promise<{ keys: JWK[] }> {
  return { keys: [TEST_PUBLIC_JWK] };
}

export async function signJwt(
  _ctx: unknown,
  claims: Record<string, unknown>,
  opts: { expiresInSeconds: number; audience?: string; issuer?: string; kid?: string },
): Promise<string> {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: opts.kid ?? TEST_KID })
    .setIssuedAt();
  if (opts.issuer) jwt.setIssuer(opts.issuer);
  if (opts.audience) jwt.setAudience(opts.audience);
  jwt.setExpirationTime(Math.floor(Date.now() / 1000) + opts.expiresInSeconds);
  return jwt.sign(privateKey);
}

export async function verifySessionToken(_ctx: unknown, token: string) {
  const { payload } = await jwtVerify(token, publicKey);
  return payload;
}

export async function signSessionToken(): Promise<string> {
  throw new Error("signSessionToken is not used by the machine test suite");
}

export async function generateSigningKey(): Promise<never> {
  throw new Error("generateSigningKey is not used by the machine test suite");
}

export async function getActiveSigningKey(): Promise<never> {
  throw new Error("getActiveSigningKey is not used by the machine test suite");
}
