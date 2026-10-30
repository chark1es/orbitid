import { describe, expect, it } from "vitest";
import { decodeJwtPayload, isTokenExpired, tokenExpiresAt } from "../util/jwt";

function encode(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function token(payload: Record<string, unknown>): string {
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(payload)}.signature`;
}

describe("decodeJwtPayload", () => {
  it("decodes UTF-8 claims without mojibake", () => {
    const jwt = token({ sub: "user_1", sid: "sess_1", name: "José", org_slug: "café", emoji: "💫" });
    expect(decodeJwtPayload(jwt)).toMatchObject({
      sub: "user_1",
      sid: "sess_1",
      name: "José",
      org_slug: "café",
      emoji: "💫",
    });
  });

  it("returns null for malformed tokens", () => {
    expect(decodeJwtPayload("not-a-jwt")).toBeNull();
    expect(decodeJwtPayload("a.!!!.c")).toBeNull();
    expect(decodeJwtPayload("a.eyJzdWIiOiJ1c2VyXzEifQ")).not.toBeNull();
  });
});

describe("token expiry", () => {
  it("compensates for client/server clock skew using iat", () => {
    const jwt = token({ iat: 1_000, exp: 1_060 });
    // The local clock is 5 s ahead of the server, so the token lasts 5 s longer in local time.
    expect(tokenExpiresAt(jwt, 1_005_000)).toBe(1_065_000);
    expect(isTokenExpired(jwt, 1_005_000)).toBe(false);
    expect(isTokenExpired(jwt, 1_065_000)).toBe(true);
  });

  it("treats a token without exp as expired", () => {
    expect(isTokenExpired(token({ sub: "user_1" }), Date.now())).toBe(true);
  });
});
