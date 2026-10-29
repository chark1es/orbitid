import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { isPrivateAddress, safeFetch } from "../../src/lib/safe-fetch";

describe("isPrivateAddress", () => {
  it.each([
    "::", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.1.2.3", "::ffff:a9fe:a9fe", "::127.0.0.1", "0:0:0:0:0:ffff:7f00:1",
    "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "2002:7f00:1::1", "2002:a9fe:a9fe::", "fc00::1", "fd12:3456::1", "fe80::1", "fec0::1", "ff02::1",
    "2001:db8::1", "100::1",
    "127.0.0.1", "10.0.0.1", "169.254.169.254", "172.16.5.4", "192.168.1.1", "100.64.0.1", "0.0.0.0",
  ])("blocks %s", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::"])("allows %s", (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });
});

describe("safeFetch redirects and mapped addresses", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
  });
  const listen = (handler: (req: IncomingMessage, body: string) => { status: number; headers?: Record<string, string>; body?: string }) =>
    new Promise<{ url: string; seen: { headers: IncomingMessage["headers"]; body: string; method?: string }[] }>((resolve) => {
      const seen: { headers: IncomingMessage["headers"]; body: string; method?: string }[] = [];
      const server = createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          seen.push({ headers: req.headers, body, method: req.method });
          const out = handler(req, body);
          res.writeHead(out.status, out.headers);
          res.end(out.body ?? "");
        });
      });
      servers.push(server);
      server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }));
    });

  it("refuses an IPv4-mapped IPv6 loopback literal when private networks are off", async () => {
    const target = await listen(() => ({ status: 200, body: "INTERNAL_SECRET" }));
    const port = new URL(target.url).port;
    await expect(safeFetch(null, `http://[::ffff:127.0.0.1]:${port}/`)).rejects.toThrow(/non-public/);
    expect(target.seen).toHaveLength(0);
  });

  it("does not send credentials or a request body to another origin on a 307", async () => {
    process.env.ORBITID_ALLOW_PRIVATE_NETWORKS = "true";
    try {
      const other = await listen(() => ({ status: 200, body: "ok" }));
      const first = await listen(() => ({ status: 307, headers: { location: `http://localhost:${new URL(other.url).port}/steal` } }));
      await expect(safeFetch(null, `${first.url}/token`, {
        method: "POST",
        headers: { Authorization: "Bearer PRIVATE", "content-type": "application/x-www-form-urlencoded" },
        body: "client_secret=PRIVATE_CLIENT_SECRET&code=AUTH_CODE",
      })).rejects.toThrow(/another origin/);
      expect(other.seen).toHaveLength(0);
    } finally {
      delete process.env.ORBITID_ALLOW_PRIVATE_NETWORKS;
    }
  });

  it("turns a cross-origin 302 into a body-less GET without the Authorization header", async () => {
    process.env.ORBITID_ALLOW_PRIVATE_NETWORKS = "true";
    try {
      const other = await listen(() => ({ status: 200, body: "ok" }));
      const first = await listen(() => ({ status: 302, headers: { location: `http://localhost:${new URL(other.url).port}/next` } }));
      const res = await safeFetch(null, `${first.url}/start`, { method: "POST", headers: { Authorization: "Bearer PRIVATE" }, body: "secret=1" });
      expect(res.body).toBe("ok");
      expect(other.seen[0]!.method).toBe("GET");
      expect(other.seen[0]!.body).toBe("");
      expect(other.seen[0]!.headers.authorization).toBeUndefined();
    } finally {
      delete process.env.ORBITID_ALLOW_PRIVATE_NETWORKS;
    }
  });

  it("keeps credentials and the method on a same-origin 307", async () => {
    process.env.ORBITID_ALLOW_PRIVATE_NETWORKS = "true";
    try {
      let calls = 0;
      const server = await listen((req) => (++calls === 1 ? { status: 307, headers: { location: "/again" } } : { status: 200, body: req.headers.authorization ?? "" }));
      const res = await safeFetch(null, `${server.url}/a`, { method: "POST", headers: { Authorization: "Bearer KEEP" }, body: "x=1" });
      expect(res.body).toBe("Bearer KEEP");
      expect(server.seen[1]!.method).toBe("POST");
      expect(server.seen[1]!.body).toBe("x=1");
    } finally {
      delete process.env.ORBITID_ALLOW_PRIVATE_NETWORKS;
    }
  });
});
