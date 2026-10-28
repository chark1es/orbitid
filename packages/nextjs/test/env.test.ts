import { afterEach, describe, expect, it } from "vitest";
import { encodePublishableKey } from "@orbitid/shared";
import {
  buildAuthUrl,
  getPublicEnv,
  getServerEnv,
  parseAuthorizedParties,
  resolveApiUrl,
  resolveJwksUrl,
} from "../src/env";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("env resolution", () => {
  it("derives the API URL from the publishable key", () => {
    const key = encodePublishableKey("https://auth.acme.dev");
    expect(resolveApiUrl({ publishableKey: key })).toBe("https://auth.acme.dev");
    expect(getPublicEnv({ publishableKey: key }).apiUrl).toBe("https://auth.acme.dev");
  });

  it("prefers NEXT_PUBLIC_ORBITID_API_URL over the key", () => {
    const key = encodePublishableKey("https://auth.acme.dev");
    process.env.NEXT_PUBLIC_ORBITID_API_URL = "http://localhost:4000/";
    expect(resolveApiUrl({ publishableKey: key })).toBe("http://localhost:4000");
  });

  it("falls back to localhost without any configuration", () => {
    expect(resolveApiUrl({ publishableKey: undefined })).toBe("http://localhost:4000");
  });

  it("builds the JWKS URL", () => {
    expect(resolveJwksUrl("https://auth.acme.dev")).toBe("https://auth.acme.dev/.well-known/jwks.json");
    expect(resolveJwksUrl("https://auth.acme.dev/.well-known/jwks.json")).toBe(
      "https://auth.acme.dev/.well-known/jwks.json",
    );
  });

  it("parses comma-separated authorized parties", () => {
    expect(parseAuthorizedParties("https://a.test, https://b.test/")).toEqual([
      "https://a.test",
      "https://b.test",
    ]);
    expect(parseAuthorizedParties("")).toBeUndefined();
    expect(parseAuthorizedParties(["https://a.test"])).toEqual(["https://a.test"]);
  });

  it("merges overrides into the server env", () => {
    const env = getServerEnv({
      publishableKey: encodePublishableKey("https://auth.test"),
      secretKey: "sk_test_123",
      jwtKey: "pem",
      signInUrl: "/login",
      signUpUrl: "/register",
    });
    expect(env.apiUrl).toBe("https://auth.test");
    expect(env.jwksUrl).toBe("https://auth.test/.well-known/jwks.json");
    expect(env.secretKey).toBe("sk_test_123");
    expect(env.jwtKey).toBe("pem");
    expect(env.signInUrl).toBe("/login");
    expect(env.signUpUrl).toBe("/register");
    expect(env.afterSignInUrl).toBe("/");
  });

  it("reads NEXT_PUBLIC defaults", () => {
    process.env.NEXT_PUBLIC_ORBITID_SIGN_IN_URL = "/signin";
    process.env.NEXT_PUBLIC_ORBITID_SIGN_UP_URL = "/signup";
    process.env.NEXT_PUBLIC_ORBITID_AFTER_SIGN_IN_URL = "/app";
    process.env.NEXT_PUBLIC_ORBITID_AFTER_SIGN_UP_URL = "/welcome";
    const env = getPublicEnv();
    expect(env.signInUrl).toBe("/signin");
    expect(env.signUpUrl).toBe("/signup");
    expect(env.afterSignInUrl).toBe("/app");
    expect(env.afterSignUpUrl).toBe("/welcome");
  });
});

describe("buildAuthUrl", () => {
  it("adds redirect_url to relative URLs", () => {
    expect(buildAuthUrl("/sign-in", "https://app.test/dashboard")).toBe(
      `/sign-in?redirect_url=${encodeURIComponent("https://app.test/dashboard")}`,
    );
  });

  it("adds redirect_url to absolute URLs and keeps hashes", () => {
    expect(buildAuthUrl("https://app.test/sign-in", "/dashboard")).toBe(
      `https://app.test/sign-in?redirect_url=${encodeURIComponent("/dashboard")}`,
    );
    expect(buildAuthUrl("/sign-in#hash", "/dashboard")).toBe(
      `/sign-in?redirect_url=${encodeURIComponent("/dashboard")}#hash`,
    );
  });

  it("returns the URL untouched without a return target", () => {
    expect(buildAuthUrl("/sign-in")).toBe("/sign-in");
  });
});
