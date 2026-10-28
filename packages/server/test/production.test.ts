import { describe, expect, it } from "vitest";
import { createContext } from "../src/bootstrap";
import { loadEnv } from "../src/env";

describe("production defaults", () => {
  it("refuses to start without an encryption key", () => {
    expect(() => loadEnv({ nodeEnv: "production" })).toThrow(/ORBITID_ENCRYPTION_KEY/);
  });

  it("refuses an encryption key shorter than 32 characters", () => {
    expect(() => loadEnv({ nodeEnv: "production", encryptionKey: "short" })).toThrow(/at least 32/);
    expect(() => loadEnv({ nodeEnv: "production", encryptionKey: "k".repeat(32) })).not.toThrow();
  });

  it("refuses the built-in development key with Postgres or a public URL", () => {
    expect(() => loadEnv({ nodeEnv: "development", databaseUrl: "postgres://u:p@db/orbit" })).toThrow(/ORBITID_ENCRYPTION_KEY/);
    expect(() => loadEnv({ nodeEnv: "development", baseUrl: "https://auth.example.com" })).toThrow(/ORBITID_ENCRYPTION_KEY/);
    expect(() => loadEnv({ nodeEnv: "development", databaseUrl: "sqlite:./x.db", baseUrl: "http://localhost:4000" })).not.toThrow();
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
