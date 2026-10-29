import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { clientIp } from "../src/lib/http";

const app = new Hono().get("/ip", (c) => c.text(clientIp(c)));
const ask = async (forwarded: string) => (await app.request("/ip", { headers: { "x-forwarded-for": forwarded } })).text();

describe("clientIp", () => {
  afterEach(() => {
    delete process.env.ORBITID_TRUST_PROXY;
  });

  it("ignores X-Forwarded-For unless a proxy is trusted", async () => {
    expect(await ask("203.0.113.9")).toBe("127.0.0.1");
  });

  it("takes the entry the trusted proxy appended, not the one the client sent", async () => {
    process.env.ORBITID_TRUST_PROXY = "1";
    expect(await ask("6.6.6.6, 198.51.100.4")).toBe("198.51.100.4");
    process.env.ORBITID_TRUST_PROXY = "2";
    expect(await ask("6.6.6.6, 198.51.100.4, 10.0.0.2")).toBe("198.51.100.4");
  });
});
