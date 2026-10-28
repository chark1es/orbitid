import { SignJWT, exportSPKI, generateKeyPair, type KeyLike } from "jose";

export interface TestKeys {
  privateKey: KeyLike;
  publicKeyPem: string;
}

let keysPromise: Promise<TestKeys> | null = null;

export function getTestKeys(): Promise<TestKeys> {
  keysPromise ??= (async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    return { privateKey, publicKeyPem: await exportSPKI(publicKey) };
  })();
  return keysPromise;
}

export interface TestClaims {
  sub?: string;
  sid?: string;
  org_id?: string;
  org_slug?: string;
  org_role?: string;
  org_permissions?: string[];
  azp?: string;
  fva?: [number, number];
  sts?: "active" | "pending";
  [key: string]: unknown;
}

export interface SignOptions {
  expiresInSeconds?: number;
  issuer?: string;
  audience?: string;
}

export async function signTestToken(
  claims: TestClaims = {},
  options: SignOptions = {},
): Promise<string> {
  const { privateKey } = await getTestKeys();
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = options.expiresInSeconds ?? 60;
  const payload: Record<string, unknown> = {
    sid: claims.sid ?? "sess_test",
    ...claims,
  };
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setSubject(claims.sub ?? "user_test")
    .setIssuedAt(now)
    .setNotBefore(now - 5)
    .setExpirationTime(now + expiresIn)
    .setIssuer(options.issuer ?? "http://localhost:4000")
    .setAudience(options.audience ?? "orbitid")
    .sign(privateKey);
}

export async function signExpiredToken(claims: TestClaims = {}): Promise<string> {
  const { privateKey } = await getTestKeys();
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sid: "sess_test", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setSubject(claims.sub ?? "user_test")
    .setIssuedAt(now - 120)
    .setNotBefore(now - 120)
    .setExpirationTime(now - 60)
    .sign(privateKey);
}
