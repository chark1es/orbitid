import { describe, expect, it } from "vitest";
import { createContext } from "../src/bootstrap";
import { loadEnv } from "../src/env";

describe("production defaults", () => {
  it("refuses to start without an encryption key", () => {
    expect(() => loadEnv({ nodeEnv: "production" })).toThrow(/ORBITID_ENCRYPTION_KEY/);
  });

  it("derives the same secret key from the encryption key on every boot", async () => {
    const options = { databaseUrl: ":memory:", nodeEnv: "production", encryptionKey: "k".repeat(40), baseUrl: "https://auth.example.com" } as const;
    const [a, b] = [await createContext(options), await createContext(options)];
    expect(a.env.secretKey).toBe(b.env.secretKey);
    expect(a.env.secretKey).toMatch(/^sk_live_/);
    const other = await createContext({ ...options, encryptionKey: "j".repeat(40) });
    expect(other.env.secretKey).not.toBe(a.env.secretKey);
  });

  it("starts a new production instance with no trusted origins", async () => {
    const ctx = await createContext({ databaseUrl: ":memory:", nodeEnv: "production", encryptionKey: "k".repeat(40) });
    const { application } = ctx.settings.get();
    expect(application.developmentMode).toBe(false);
    expect(application.allowedOrigins).toEqual([]);
  });
});
