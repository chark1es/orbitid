// Apple sign-in: the ES256 client secret minted from a .p8 key, its cache, and Apple ID token verification.
import { afterEach, describe, expect, it } from "vitest";
import { createPublicKey } from "node:crypto";
import { decodeProtectedHeader, exportJWK, exportPKCS8, generateKeyPair, importJWK, importPKCS8, jwtVerify, SignJWT, type KeyLike } from "jose";
import {
  appleClientSecret, appleProfileName, APPLE_ISSUER, getOAuthAdapter, providerConfig, registerAppleJwks,
  resetAppleClientSecretCache, verifyAppleIdToken,
} from "../../src/services/oauth-providers";
import { setup } from "../core/helpers";
import type { AppContext } from "../../src/context";

const CLIENT_ID = "com.example.web";
const TEAM_ID = "TEAM123456";
const KEY_ID = "KEY7890123";

/** A real P-256 key in the shape Apple hands out: the .p8 PKCS#8 PEM (plus its public half for checks). */
async function p256() {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  return { privateKey, publicKey, pkcs8: await exportPKCS8(privateKey) };
}

async function enableApple(ctx: AppContext, cfg: Record<string, unknown>) {
  await ctx.settings.update({ social: { apple: { enabled: true, clientId: CLIENT_ID, scopes: ["name", "email"], ...cfg } } });
}

const configFor = (ctx: AppContext) => providerConfig(ctx, "apple")!;

afterEach(() => {
  resetAppleClientSecretCache();
  registerAppleJwks(null);
});

describe("Apple client secret", () => {
  it("mints an ES256 JWT with the team id, client id and Apple audience", async () => {
    const { publicKey, pkcs8 } = await p256();
    const { ctx } = await setup();
    await enableApple(ctx, { appleTeamId: TEAM_ID, appleKeyId: KEY_ID, applePrivateKey: pkcs8 });

    const secret = await appleClientSecret(configFor(ctx));
    expect(decodeProtectedHeader(secret)).toMatchObject({ alg: "ES256", kid: KEY_ID });

    const { payload } = await jwtVerify(secret, publicKey, { issuer: TEAM_ID, audience: APPLE_ISSUER, subject: CLIENT_ID });
    expect(payload.iss).toBe(TEAM_ID);
    expect(payload.sub).toBe(CLIENT_ID);
    expect(payload.aud).toBe(APPLE_ISSUER);
    const lifetime = (payload.exp as number) - (payload.iat as number);
    expect(lifetime).toBeLessThanOrEqual(180 * 24 * 60 * 60);
    expect(lifetime).toBeGreaterThan(179 * 24 * 60 * 60);
  });

  it("signs with the private key from the .p8, matching the public half", async () => {
    const { publicKey, pkcs8 } = await p256();
    const { ctx } = await setup();
    await enableApple(ctx, { appleTeamId: TEAM_ID, appleKeyId: KEY_ID, applePrivateKey: pkcs8 });
    // The public key is derived from the same PEM, not from the original KeyObject.
    const derived = createPublicKeyFromPem(pkcs8);
    const secret = await appleClientSecret(configFor(ctx));
    await expect(jwtVerify(secret, derived, { issuer: TEAM_ID, audience: APPLE_ISSUER })).resolves.toBeTruthy();
    expect((await exportJWK(publicKey)).x).toBe((await exportJWK(derived)).x);
  });

  it("accepts a key pasted without the PEM header or line breaks", async () => {
    const { publicKey, pkcs8 } = await p256();
    const { ctx } = await setup();
    const bare = pkcs8.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    await enableApple(ctx, { appleTeamId: TEAM_ID, appleKeyId: KEY_ID, applePrivateKey: bare });

    const secret = await appleClientSecret(configFor(ctx));
    await expect(jwtVerify(secret, publicKey, { issuer: TEAM_ID, audience: APPLE_ISSUER })).resolves.toBeTruthy();
  });

  it("caches the secret until shortly before it expires, then mints a new one", async () => {
    const { publicKey, pkcs8 } = await p256();
    const { ctx } = await setup();
    await enableApple(ctx, { appleTeamId: TEAM_ID, appleKeyId: KEY_ID, applePrivateKey: pkcs8 });
    const cfg = configFor(ctx);

    const first = await appleClientSecret(cfg);
    expect(await appleClientSecret(cfg)).toBe(first);
    // A day before expiry the cached value is still accepted…
    expect(await appleClientSecret(cfg, Date.now() + 178 * 24 * 60 * 60 * 1000)).toBe(first);
    // …but a request that would outlive the renewal window gets a fresh one.
    const renewed = await appleClientSecret(cfg, Date.now() + (180 * 24 * 60 * 60 - 60) * 1000);
    expect(renewed).not.toBe(first);
    await expect(jwtVerify(renewed, publicKey, { issuer: TEAM_ID, audience: APPLE_ISSUER })).resolves.toBeTruthy();
  });

  it("prefers a configured client secret and refuses a key that is not a P-256 private key", async () => {
    const { ctx } = await setup();
    await enableApple(ctx, { clientSecret: "pre-generated-secret" });
    expect(await appleClientSecret(configFor(ctx))).toBe("pre-generated-secret");

    await enableApple(ctx, { clientSecret: "", appleTeamId: TEAM_ID, appleKeyId: KEY_ID, applePrivateKey: "not-a-key" });
    await expect(appleClientSecret(configFor(ctx))).rejects.toThrow(/valid ES256/);

    await enableApple(ctx, { clientSecret: "", appleTeamId: "", appleKeyId: "", applePrivateKey: "" });
    await expect(appleClientSecret(configFor(ctx))).rejects.toThrow(/needs a client secret/);
  });

  it("does not share a cached secret between different keys", async () => {
    const one = await p256();
    const two = await p256();
    const { ctx } = await setup();

    await enableApple(ctx, { appleTeamId: TEAM_ID, appleKeyId: KEY_ID, applePrivateKey: one.pkcs8 });
    const first = await appleClientSecret(configFor(ctx));
    await enableApple(ctx, { appleTeamId: TEAM_ID, appleKeyId: "OTHERKEY", applePrivateKey: two.pkcs8 });
    const second = await appleClientSecret(configFor(ctx));
    expect(second).not.toBe(first);
    await expect(jwtVerify(second, two.publicKey, { issuer: TEAM_ID, audience: APPLE_ISSUER })).resolves.toBeTruthy();
  });
});

describe("Apple ID token verification", () => {
  async function useAppleKey(publicKey: KeyLike, kid = KEY_ID) {
    const jwk = { ...(await exportJWK(publicKey)), alg: "ES256", use: "sig", kid };
    const key = await importJWK(jwk, "ES256");
    registerAppleJwks(async () => key as CryptoKey);
  }

  const signIdToken = (privateKey: KeyLike, claims: Record<string, unknown>, opts: { iss?: string; aud?: string } = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "ES256", kid: KEY_ID })
      .setIssuer(opts.iss ?? APPLE_ISSUER)
      .setAudience(opts.aud ?? CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .sign(privateKey);

  it("accepts a correctly signed token and rejects the wrong issuer, audience or key", async () => {
    const { privateKey, publicKey } = await p256();
    await useAppleKey(publicKey);
    const good = await signIdToken(privateKey, { sub: "apple-user-1", email: "ada@example.com", email_verified: "true" });
    const claims = await verifyAppleIdToken(good, CLIENT_ID);
    expect(claims).toMatchObject({ sub: "apple-user-1", email: "ada@example.com", iss: APPLE_ISSUER, aud: CLIENT_ID });

    await expect(verifyAppleIdToken(await signIdToken(privateKey, { sub: "x" }, { iss: "https://evil.example" }), CLIENT_ID)).rejects.toThrow(/verified/);
    await expect(verifyAppleIdToken(await signIdToken(privateKey, { sub: "x" }, { aud: "com.other.app" }), CLIENT_ID)).rejects.toThrow(/verified/);

    const stranger = await p256();
    await expect(verifyAppleIdToken(await signIdToken(stranger.privateKey, { sub: "x" }), CLIENT_ID)).rejects.toThrow(/verified/);
  });

  it("rejects an expired token", async () => {
    const { privateKey, publicKey } = await p256();
    await useAppleKey(publicKey);
    const now = Math.floor(Date.now() / 1000);
    const expired = await new SignJWT({ sub: "x" })
      .setProtectedHeader({ alg: "ES256", kid: KEY_ID })
      .setIssuer(APPLE_ISSUER).setAudience(CLIENT_ID).setIssuedAt(now - 3600).setExpirationTime(now - 600)
      .sign(privateKey);
    await expect(verifyAppleIdToken(expired, CLIENT_ID)).rejects.toThrow(/verified/);
  });
});

/** node's createPublicKey accepts a PKCS#8 private key PEM and yields its public half. */
function createPublicKeyFromPem(pem: string): CryptoKey {
  return createPublicKey(pem) as unknown as CryptoKey;
}

/** Guards the fixture helper: the PEM the server receives must be importable as an ES256 signing key. */
describe("Apple key fixture", () => {
  it("exports a PEM that imports back as an ES256 key", async () => {
    const { pkcs8, publicKey } = await p256();
    const imported = await importPKCS8(pkcs8, "ES256");
    const jwk = await exportJWK(imported as CryptoKey);
    expect(jwk.kty).toBe("EC");
    expect(jwk.crv).toBe("P-256");
    expect(jwk.x).toBe((await exportJWK(publicKey)).x);
  });
});

describe("Apple code exchange", () => {
  it("sends the generated secret to Apple and reads the verified ID token", async () => {
    const secretKey = await p256();
    const idKey = await p256();
    await useAppleKeyStatic(idKey.publicKey);
    const { ctx } = await setup();
    await enableApple(ctx, { appleTeamId: TEAM_ID, appleKeyId: KEY_ID, applePrivateKey: secretKey.pkcs8 });
    const adapter = await getOAuthAdapter(ctx, "apple");
    expect(adapter).toBeTruthy();

    const idToken = await new SignJWT({ sub: "apple-user-7", email: "ada@example.com", email_verified: "true" })
      .setProtectedHeader({ alg: "ES256", kid: KEY_ID })
      .setIssuer(APPLE_ISSUER).setAudience(CLIENT_ID).setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .sign(idKey.privateKey);

    const seen: { url: string; body: string }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ access_token: "apple-access", refresh_token: "apple-refresh", id_token: idToken, expires_in: 3600 }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const tokens = await adapter!.exchangeCode({ code: "apple-code", codeVerifier: "" });
      expect(seen[0]!.url).toBe("https://appleid.apple.com/auth/token");
      const sent = new URLSearchParams(seen[0]!.body);
      expect(sent.get("code")).toBe("apple-code");
      expect(sent.get("grant_type")).toBe("authorization_code");
      expect(sent.get("client_id")).toBe(CLIENT_ID);
      const secret = sent.get("client_secret")!;
      expect(decodeProtectedHeader(secret)).toMatchObject({ alg: "ES256", kid: KEY_ID });
      await expect(jwtVerify(secret, secretKey.publicKey, { issuer: TEAM_ID, audience: APPLE_ISSUER })).resolves.toBeTruthy();

      // The profile comes from the ID token that was verified before anything read it.
      const profile = await adapter!.fetchProfile({ tokens });
      expect(profile).toMatchObject({
        provider: "apple", providerUserId: "apple-user-7", email: "ada@example.com", emailVerified: true,
        accessToken: "apple-access", refreshToken: "apple-refresh",
      });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("refuses an ID token Apple returns that does not verify", async () => {
    const secretKey = await p256();
    const stranger = await p256();
    await useAppleKeyStatic(stranger.publicKey);
    const { ctx } = await setup();
    await enableApple(ctx, { appleTeamId: TEAM_ID, appleKeyId: KEY_ID, applePrivateKey: secretKey.pkcs8 });
    const adapter = await getOAuthAdapter(ctx, "apple");
    const forged = await new SignJWT({ sub: "x" })
      .setProtectedHeader({ alg: "ES256", kid: KEY_ID })
      .setIssuer(APPLE_ISSUER).setAudience(CLIENT_ID).setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .sign((await p256()).privateKey);
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ access_token: "a", id_token: forged }), { headers: { "content-type": "application/json" } })) as typeof fetch;
    try {
      await expect(adapter!.exchangeCode({ code: "c", codeVerifier: "" })).rejects.toThrow(/verified/);
    } finally {
      globalThis.fetch = original;
    }
  });
});

/** Registers a fixed public key as Apple's published JWKS for the duration of a test. */
async function useAppleKeyStatic(publicKey: KeyLike) {
  const jwk = { ...(await exportJWK(publicKey)), alg: "ES256", use: "sig", kid: KEY_ID };
  const key = await importJWK(jwk, "ES256");
  registerAppleJwks(async () => key as CryptoKey);
}

describe("Apple first-authorization name", () => {
  it("uses the `user` form_post field only when Apple sends it", () => {
    expect(appleProfileName(JSON.stringify({ name: { firstName: "Ada", lastName: "Lovelace" }, email: "ada@example.com" })))
      .toEqual({ firstName: "Ada", lastName: "Lovelace" });
    expect(appleProfileName(undefined)).toEqual({});
    expect(appleProfileName("")).toEqual({});
    expect(appleProfileName("not json")).toEqual({});
    // Later authorizations send `{"name":null}` or nothing: no name must be invented.
    expect(appleProfileName(JSON.stringify({ name: null }))).toEqual({});
  });
});
