import { describe, expect, it } from "vitest";
import {
  decodeJwt,
  formatClaimValue,
  formatExpiry,
  formatRemaining,
  orderClaims,
  tokenExpiry,
} from "./jwt";

function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const header = { alg: "RS256", kid: "key_1", typ: "JWT" };
const claims = {
  sub: "user_123",
  sid: "sess_456",
  iss: "http://localhost:4000",
  exp: 1700000000,
  org_permissions: ["org:sys_memberships:read"],
  name: "Jörg Müller",
};

describe("decodeJwt", () => {
  it("decodes the header and claims, including non-ASCII text", () => {
    const token = `${encodeSegment(header)}.${encodeSegment(claims)}.signature`;
    const result = decodeJwt(token);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.jwt.header).toEqual(header);
    expect(result.jwt.claims.sub).toBe("user_123");
    expect(result.jwt.claims.name).toBe("Jörg Müller");
    expect(result.jwt.signature).toBe("signature");
  });

  it("rejects a token without three segments", () => {
    expect(decodeJwt("abc.def")).toEqual({
      ok: false,
      error: "A JWT has three segments separated by dots. This token has 2.",
    });
  });

  it("rejects a segment that is not JSON", () => {
    const token = `${encodeSegment(header)}.${Buffer.from("not json").toString("base64url")}.sig`;
    const result = decodeJwt(token);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("The payload is not valid base64url JSON");
  });

  it("rejects a payload that parses to an array", () => {
    const token = `${encodeSegment(header)}.${encodeSegment([1, 2])}.sig`;
    const result = decodeJwt(token);
    expect(result).toEqual({ ok: false, error: "The payload is not a JSON object" });
  });
});

describe("tokenExpiry", () => {
  it("converts the exp claim to milliseconds and a remaining time", () => {
    const now = 1700000000 * 1000;
    expect(tokenExpiry(claims, now)).toEqual({
      expiresAt: 1700000000 * 1000,
      remainingMs: 0,
    });
    expect(tokenExpiry(claims, now - 30_000).remainingMs).toBe(30_000);
  });

  it("returns nulls when exp is absent or not a number", () => {
    expect(tokenExpiry({})).toEqual({ expiresAt: null, remainingMs: null });
    expect(tokenExpiry({ exp: "soon" })).toEqual({ expiresAt: null, remainingMs: null });
  });
});

describe("formatRemaining", () => {
  it("renders seconds, minutes and expiry", () => {
    expect(formatRemaining(42_000)).toBe("42s");
    expect(formatRemaining(65_000)).toBe("1m 05s");
    expect(formatRemaining(600_000)).toBe("10m 00s");
    expect(formatRemaining(-1)).toBe("Expired");
    expect(formatRemaining(null)).toBe("No expiry");
  });

  it("rounds part seconds up so a live token never reads 0s", () => {
    expect(formatRemaining(400)).toBe("1s");
  });
});

describe("claim presentation", () => {
  it("puts standard claims first and sorts the rest", () => {
    const ordered = orderClaims({ zebra: 1, alpha: 2, sub: "user_1", exp: 3 }).map(([key]) => key);
    expect(ordered).toEqual(["sub", "exp", "alpha", "zebra"]);
  });

  it("renders timestamps with a clock time", () => {
    expect(formatClaimValue("exp", 1700000000)).toContain("1700000000 (");
    expect(formatClaimValue("sub", "user_1")).toBe("user_1");
    expect(formatClaimValue("org_permissions", ["a", "b"])).toBe('["a","b"]');
    expect(formatClaimValue("org_id", null)).toBe("null");
  });

  it("formats an expiry clock time and handles a missing claim", () => {
    expect(formatExpiry(null)).toBe("No expiry claim");
    expect(formatExpiry(1700000000 * 1000)).toMatch(/^\d{1,2}:\d{2}:\d{2}/);
  });
});
