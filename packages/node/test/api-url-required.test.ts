import { afterEach, describe, expect, it } from "vitest";
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
});
