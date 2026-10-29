import { afterEach, describe, expect, it } from "vitest";
import { encodePublishableKey } from "@orbitid/shared";
import { createOrbitId } from "../src";

describe("createOrbitId without an API URL", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("fails closed instead of sending the secret key anywhere", () => {
    delete process.env.ORBITID_API_URL;
    delete process.env.ORBITID_PUBLISHABLE_KEY;
    expect(() => createOrbitId({ secretKey: "sk_test_" + "a".repeat(32) })).toThrow(/ORBITID_API_URL/);
  });

  it("reads the URL from a publishable key when that is all it has", () => {
    delete process.env.ORBITID_API_URL;
    const orbit = createOrbitId({ secretKey: "sk_test_" + "a".repeat(32), publishableKey: "pk_test_aHR0cDovL2xvY2FsaG9zdDo0MDAw" });
    expect(orbit.config.apiUrl).toBe("http://localhost:4000");
  });

  it("verifies tokens against the public issuer while reaching the server on an internal address", () => {
    delete process.env.ORBITID_ISSUER;
    const viaKey = createOrbitId({ secretKey: "sk_test_" + "a".repeat(32), apiUrl: "http://orbitid:4000", publishableKey: encodePublishableKey("https://auth.example.com") });
    expect(viaKey.config.apiUrl).toBe("http://orbitid:4000");
    expect(viaKey.config.issuer).toBe("https://auth.example.com");
    expect(viaKey.config.jwksUrl).toBe("http://orbitid:4000/.well-known/jwks.json");
    const explicit = createOrbitId({ secretKey: "sk_test_" + "a".repeat(32), apiUrl: "http://orbitid:4000", issuer: "https://login.example.com/" });
    expect(explicit.config.issuer).toBe("https://login.example.com");
  });
});
