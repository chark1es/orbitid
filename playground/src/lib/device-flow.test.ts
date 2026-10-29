import { describe, expect, it } from "vitest";
import {
  normalizeUserCode,
  orderApplicationsForDeviceFlow,
  parseDeviceAuthorization,
  readPollOutcome,
} from "./device-flow";

describe("parseDeviceAuthorization", () => {
  it("reads a complete response and keeps the complete verification link", () => {
    expect(
      parseDeviceAuthorization({
        device_code: "odc_1",
        user_code: "BCDF-2345",
        verification_uri: "http://localhost:4000/oauth/device",
        verification_uri_complete: "http://localhost:4000/oauth/device?user_code=BCDF-2345",
        expires_in: 600,
        interval: 5,
      }),
    ).toEqual({
      deviceCode: "odc_1",
      userCode: "BCDF-2345",
      verificationUri: "http://localhost:4000/oauth/device",
      verificationUriComplete: "http://localhost:4000/oauth/device?user_code=BCDF-2345",
      expiresIn: 600,
      interval: 5,
    });
  });

  it("falls back to the bare verification URI", () => {
    const parsed = parseDeviceAuthorization({
      device_code: "odc_1",
      user_code: "BCDF-2345",
      verification_uri: "http://localhost:4000/oauth/device",
      expires_in: 600,
      interval: 5,
    });
    expect(parsed?.verificationUriComplete).toBe("http://localhost:4000/oauth/device");
  });

  it("rejects a body that is missing a required field", () => {
    expect(parseDeviceAuthorization({ device_code: "odc_1" })).toBeNull();
    expect(parseDeviceAuthorization(null)).toBeNull();
    expect(parseDeviceAuthorization("odc_1")).toBeNull();
  });
});

describe("readPollOutcome", () => {
  it("returns the token set on success", () => {
    const outcome = readPollOutcome(200, {
      access_token: "oat_1",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "openid email",
      refresh_token: "ort_1",
      id_token: "eyJ",
    });
    expect(outcome.state).toBe("complete");
    expect(outcome.tokens).toEqual({
      accessToken: "oat_1",
      tokenType: "Bearer",
      expiresIn: 3600,
      scope: "openid email",
      hasRefreshToken: true,
      hasIdToken: true,
    });
    expect(outcome.message).toContain("Scope openid email");
  });

  it("maps the pending and slow-down answers to their own states", () => {
    expect(readPollOutcome(400, { error: "authorization_pending" })).toMatchObject({ state: "pending" });
    const slow = readPollOutcome(400, { error: "slow_down", retry_after: 10 });
    expect(slow.state).toBe("slow-down");
    expect(slow.retryAfterSeconds).toBe(10);
  });

  it("distinguishes a denial from an expired code", () => {
    expect(readPollOutcome(400, { error: "access_denied" }).state).toBe("denied");
    expect(readPollOutcome(400, { error: "expired_token" }).state).toBe("expired");
  });

  it("does not call an unknown error a success and keeps the description", () => {
    const outcome = readPollOutcome(500, { error: "server_error", error_description: "Try again later" });
    expect(outcome.state).toBe("failed");
    expect(outcome.message).toBe("Try again later");
    expect(readPollOutcome(502, null).state).toBe("failed");
  });

  it("treats 200 without a token as a failure", () => {
    expect(readPollOutcome(200, { token_type: "Bearer" })).toMatchObject({ state: "failed" });
  });
});

describe("orderApplicationsForDeviceFlow", () => {
  it("puts public applications first, then sorts by name", () => {
    const ordered = orderApplicationsForDeviceFlow([
      { name: "Zulu CLI", public: false },
      { name: "Beta TV", public: true },
      { name: "Alpha CLI", public: false },
      { name: "Able kiosk", public: true },
    ]);
    expect(ordered.map((app) => app.name)).toEqual(["Able kiosk", "Beta TV", "Alpha CLI", "Zulu CLI"]);
  });
});

describe("normalizeUserCode", () => {
  it("accepts lower case, extra spaces and a missing dash", () => {
    expect(normalizeUserCode(" bcdf-2345 ")).toBe("BCDF-2345");
    expect(normalizeUserCode("bcdf2345")).toBe("BCDF-2345");
  });

  it("leaves a partial code alone so the server can reject it", () => {
    expect(normalizeUserCode("bcdf")).toBe("BCDF");
  });
});
