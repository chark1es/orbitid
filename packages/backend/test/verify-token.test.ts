import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportJWK, exportSPKI, generateKeyPair, SignJWT, type KeyLike } from "jose";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { isTokenVerificationError, TokenVerificationError, verifyToken } from "../src/verify-token";

const ISSUER = "https://auth.example.com";

let privateKey: KeyLike;
let publicKey: KeyLike;
let publicKeyPem: string;
let otherPrivateKey: KeyLike;
let jwksServer: Server;
let jwksUrl: string;

beforeAll(async () => {
  const keyPair = await generateKeyPair("RS256");
  privateKey = keyPair.privateKey;
  publicKey = keyPair.publicKey;
  publicKeyPem = await exportSPKI(publicKey);
  otherPrivateKey = (await generateKeyPair("RS256")).privateKey;

  const jwk = { ...(await exportJWK(publicKey)), kid: "key_1", alg: "RS256", use: "sig" };
  jwksServer = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
  const address = jwksServer.address() as AddressInfo;
  jwksUrl = `http://127.0.0.1:${address.port}/.well-known/jwks.json`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => jwksServer.close((error) => (error ? reject(error) : resolve())));
});

interface SignOptions {
  issuer?: string;
  expiresAt?: number | string;
  notBefore?: number;
  issuedAt?: number;
  audience?: string;
  key?: KeyLike;
  claims?: Record<string, unknown>;
}

async function sign(options: SignOptions = {}): Promise<string> {
  let token = new SignJWT({ sid: "sess_1", org_role: "org:admin", org_permissions: ["org:sys_memberships:manage"], ...options.claims })
    .setProtectedHeader({ alg: "RS256", kid: "key_1" })
    .setIssuer(options.issuer ?? ISSUER)
    .setSubject("user_1")
    .setIssuedAt(options.issuedAt);
  token = token.setExpirationTime(options.expiresAt ?? "5m");
  if (options.notBefore) token = token.setNotBefore(options.notBefore);
  if (options.audience) token = token.setAudience(options.audience);
  return token.sign(options.key ?? privateKey);
}

async function expectReason(token: string, options: Parameters<typeof verifyToken>[1], reason: string): Promise<void> {
  const error = await verifyToken(token, options).catch((err: unknown) => err);
  expect(isTokenVerificationError(error)).toBe(true);
  expect((error as TokenVerificationError).reason).toBe(reason);
}

describe("verifyToken", () => {
  it("verifies a token offline with a PEM key and returns SessionClaims", async () => {
    const token = await sign({ audience: "orbitid", claims: { azp: "https://app.example.com" } });
    const claims = await verifyToken(token, {
      jwtKey: publicKeyPem,
      issuer: ISSUER,
      audience: "orbitid",
      authorizedParties: ["https://app.example.com"],
    });
    expect(claims.sub).toBe("user_1");
    expect(claims.sid).toBe("sess_1");
    expect(claims.org_role).toBe("org:admin");
    expect(claims.org_permissions).toEqual(["org:sys_memberships:manage"]);
  });

  it("rejects expired tokens by default and honours only the explicit expiredToleranceMs", async () => {
    const expired = Math.floor(Date.now() / 1000) - 5;
    const token = await sign({ expiresAt: expired });
    await expectReason(token, { jwtKey: publicKeyPem, issuer: ISSUER }, "token-expired");
    // The deprecated option is early-only now: it must not give an expired session another skew window.
    await expectReason(token, { jwtKey: publicKeyPem, issuer: ISSUER, clockSkewInMs: 10_000 }, "token-expired");
    const claims = await verifyToken(token, { jwtKey: publicKeyPem, issuer: ISSUER, expiredToleranceMs: 10_000 });
    expect(claims.sub).toBe("user_1");
    // Just beyond the explicit tolerance is still refused.
    await expectReason(token, { jwtKey: publicKeyPem, issuer: ISSUER, expiredToleranceMs: 1_000 }, "token-expired");
  });

  it("applies the early tolerance to nbf/iat only", async () => {
    const now = Math.floor(Date.now() / 1000);
    const early = await sign({ notBefore: now + 20, expiresAt: now + 60 });
    await expectReason(early, { jwtKey: publicKeyPem, issuer: ISSUER }, "token-not-active-yet");
    await expectReason(early, { jwtKey: publicKeyPem, issuer: ISSUER, expiredToleranceMs: 60_000 }, "token-not-active-yet");
    expect((await verifyToken(early, { jwtKey: publicKeyPem, issuer: ISSUER, clockSkewInMs: 30_000 })).sub).toBe("user_1");
    expect((await verifyToken(early, { jwtKey: publicKeyPem, issuer: ISSUER, notBeforeToleranceMs: 30_000 })).sub).toBe("user_1");
    await expectReason(early, { jwtKey: publicKeyPem, issuer: ISSUER, notBeforeToleranceMs: 5_000 }, "token-not-active-yet");
  });

  it("rejects a token issued in the future", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await sign({ issuedAt: now + 60, expiresAt: now + 120 });
    await expectReason(token, { jwtKey: publicKeyPem, issuer: ISSUER }, "token-not-active-yet");
    await expectReason(token, { jwtKey: publicKeyPem, issuer: ISSUER, expiredToleranceMs: 120_000 }, "token-not-active-yet");
    expect((await verifyToken(token, { jwtKey: publicKeyPem, issuer: ISSUER, notBeforeToleranceMs: 90_000 })).sub).toBe("user_1");
  });

  it("rejects not-yet-active tokens", async () => {
    const token = await sign({ notBefore: Math.floor(Date.now() / 1000) + 60 });
    await expectReason(token, { jwtKey: publicKeyPem, issuer: ISSUER }, "token-not-active-yet");
  });

  it("checks issuer, audience and authorized parties", async () => {
    await expectReason(await sign({ issuer: "https://evil.example.com" }), { jwtKey: publicKeyPem, issuer: ISSUER }, "invalid-issuer");
    await expectReason(
      await sign({ audience: "audience-a" }),
      { jwtKey: publicKeyPem, issuer: ISSUER, audience: "audience-b" },
      "invalid-audience",
    );
    await expectReason(
      await sign({ claims: { azp: "https://evil.example.com" } }),
      { jwtKey: publicKeyPem, issuer: ISSUER, authorizedParties: ["https://app.example.com"] },
      "invalid-authorized-party",
    );
    await expectReason(
      await sign(),
      { jwtKey: publicKeyPem, issuer: ISSUER, authorizedParties: ["https://app.example.com"] },
      "invalid-authorized-party",
    );
  });

  it("rejects malformed tokens and wrong signatures", async () => {
    await expectReason("not-a-jwt", { jwtKey: publicKeyPem, issuer: ISSUER }, "token-invalid");
    const token = await sign({ key: otherPrivateKey });
    await expectReason(token, { jwtKey: publicKeyPem, issuer: ISSUER }, "invalid-signature");
  });

  it("requires some verification key", async () => {
    const token = await sign();
    await expectReason(token, {}, "token-invalid");
  });

  it("verifies against a remote JWKS", async () => {
    const token = await sign({ claims: { azp: "https://app.example.com" } });
    const claims = await verifyToken(token, { jwksUrl, issuer: ISSUER });
    expect(claims.sid).toBe("sess_1");
    const expired = await sign({ expiresAt: Math.floor(Date.now() / 1000) - 5 });
    await expectReason(expired, { jwksUrl, issuer: ISSUER }, "token-expired");
  });

  it("rejects JWT template tokens as sessions unless explicitly requested", async () => {
    const template = await sign({ claims: { token_type: "jwt_template", plan: "pro" } });
    await expectReason(template, { jwtKey: publicKeyPem, issuer: ISSUER }, "token-invalid");

    const claims = await verifyToken(template, { jwtKey: publicKeyPem, issuer: ISSUER, tokenType: "jwt_template" });
    expect(claims.sub).toBe("user_1");
    expect((claims as unknown as Record<string, unknown>).plan).toBe("pro");

    // Asking for a template token does not make an ordinary session token one.
    await expectReason(await sign(), { jwtKey: publicKeyPem, issuer: ISSUER, tokenType: "jwt_template" }, "token-invalid");
  });

  it("refuses to verify with a jwtKey when no issuer is known", async () => {
    const token = await sign({});
    await expectReason(token, { jwtKey: publicKeyPem }, "invalid-issuer");
    const claims = await verifyToken(token, { jwtKey: publicKeyPem, apiUrl: ISSUER });
    expect(claims.sub).toBeTruthy();
  });
});
