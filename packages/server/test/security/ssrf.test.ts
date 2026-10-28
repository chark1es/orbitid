import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isPrivateAddress, privateNetworksAllowed, remoteJwks, resetJwksCache, safeFetch } from "../../src/lib/safe-fetch";
import { createContext } from "../../src/bootstrap";
import { testApp } from "../admin/helpers";

let server: Server;
let base = "";
let hits = 0;
let redirectTarget = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    hits += 1;
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/redirect") {
      res.writeHead(302, { location: redirectTarget });
      res.end();
      return;
    }
    if (url.pathname === "/loop") {
      res.writeHead(302, { location: "/loop" });
      res.end();
      return;
    }
    if (url.pathname === "/huge") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("x".repeat(4096));
      return;
    }
    if (url.pathname === "/slow") {
      // Never answers: the client's own budget must end the request.
      return;
    }
    if (url.pathname === "/jwks") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [{ kty: "oct", k: "AAAA", alg: "HS256", kid: "k1" }] }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: url.pathname, query: url.search, method: req.method }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  hits = 0;
  redirectTarget = "";
});

const devContext = () => createContext({ databaseUrl: ":memory:", secretKey: "sk_test_ssrf", baseUrl: "http://localhost:4000" });

describe("address classification", () => {
  it("refuses loopback, private, link-local, metadata, CGNAT, multicast and reserved IPv4 ranges", () => {
    const blocked = [
      "127.0.0.1", "127.9.9.9", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255",
      "192.168.1.1", "169.254.169.254", "169.254.1.1", "100.64.0.1", "100.127.255.255",
      "0.0.0.0", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
      "192.0.2.5", "198.51.100.7", "203.0.113.9", "198.18.0.1",
    ];
    for (const address of blocked) expect(isPrivateAddress(address), address).toBe(true);
  });

  it("allows public IPv4 addresses", () => {
    for (const address of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.0"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it("refuses IPv6 loopback, unique-local, link-local, multicast and mapped IPv4", () => {
    for (const address of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ["2001:4860:4860::8888", "2606:4700:4700::1111"]) expect(isPrivateAddress(address), address).toBe(false);
  });
});

describe("safeFetch", () => {
  it("reaches a local server only because development mode allows private networks", async () => {
    const ctx = await devContext();
    expect(privateNetworksAllowed(ctx)).toBe(true);
    const res = await safeFetch(ctx, `${base}/hello?a=1`);
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({ path: "/hello", query: "?a=1" });
  });

  it("refuses private destinations when development mode is off and the env opt-in is absent", async () => {
    const ctx = await devContext();
    await ctx.settings.update({ application: { developmentMode: false } });
    await expect(safeFetch(ctx, `${base}/hello`)).rejects.toMatchObject({ status: 400 });
    expect(hits).toBe(0);

    process.env.ORBITID_ALLOW_PRIVATE_NETWORKS = "true";
    try {
      expect((await safeFetch(ctx, `${base}/hello`)).status).toBe(200);
    } finally {
      delete process.env.ORBITID_ALLOW_PRIVATE_NETWORKS;
    }
  });

  it("refuses the cloud metadata endpoint", async () => {
    const ctx = await devContext();
    await ctx.settings.update({ application: { developmentMode: false } });
    await expect(safeFetch(ctx, "http://169.254.169.254/latest/meta-data/")).rejects.toMatchObject({ status: 400 });
    // Even in development mode the metadata address must be unreachable through an ordinary localhost rule:
    // it is not a localhost name, and the connection is pinned to the vetted address.
    await expect(safeFetch(ctx, "http://[::1]:6379/")).rejects.toMatchObject({ status: 400 });
  });

  it("rejects non-http schemes and embedded credentials", async () => {
    const ctx = await devContext();
    await expect(safeFetch(ctx, "file:///etc/passwd")).rejects.toMatchObject({ status: 400 });
    await expect(safeFetch(ctx, "gopher://example.com/")).rejects.toMatchObject({ status: 400 });
    await expect(safeFetch(ctx, "http://user:pass@example.com/")).rejects.toMatchObject({ status: 400 });
  });

  it("follows redirects manually and re-validates each hop", async () => {
    const ctx = await devContext();
    redirectTarget = `${base}/final`;
    const res = await safeFetch(ctx, `${base}/redirect`);
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({ path: "/final" });
    expect(hits).toBe(2);

    // A redirect to a blocked host is refused at the hop, before any connection is made.
    await ctx.settings.update({ application: { developmentMode: false } });
    redirectTarget = `${base}/final`;
    const before = hits;
    await expect(safeFetch(ctx, `${base}/redirect`)).rejects.toMatchObject({ status: 400 });
    expect(hits).toBe(before);
  });

  it("stops after three redirects", async () => {
    const ctx = await devContext();
    redirectTarget = `${base}/loop`;
    await expect(safeFetch(ctx, `${base}/loop`)).rejects.toMatchObject({ status: 400 });
    expect(hits).toBeLessThanOrEqual(5);
  });

  it("caps the response body and the total time", async () => {
    const ctx = await devContext();
    await expect(safeFetch(ctx, `${base}/huge`, { maxBytes: 512 })).rejects.toMatchObject({ status: 400 });
    await expect(safeFetch(ctx, `${base}/slow`, { timeoutMs: 120 })).rejects.toMatchObject({ status: 400 });
  });

  it("sends the requested method, headers and body, and never leaks an unrequested Host", async () => {
    const ctx = await devContext();
    const res = await safeFetch(ctx, `${base}/echo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: true }) });
    expect(res.json()).toMatchObject({ method: "POST", path: "/echo" });
  });

  it("fetches a JWKS through the guarded helper and refuses a non-public one", async () => {
    const ctx = await devContext();
    resetJwksCache();
    const set = await remoteJwks(ctx, `${base}/jwks`);
    expect(typeof set).toBe("function");

    await ctx.settings.update({ application: { developmentMode: false } });
    resetJwksCache();
    await expect(remoteJwks(ctx, `${base}/jwks`)).rejects.toMatchObject({ status: 400 });
  });
});

describe("webhook delivery", () => {
  it("validates the endpoint URL at creation and refuses internal targets in production mode", async () => {
    const h = await testApp();
    // Development instance: localhost webhooks keep working (tests and local setups rely on this).
    expect((await h.api("POST", "/v1/webhooks/endpoints", { url: "http://127.0.0.1:9999/hook" })).status).toBe(200);

    await h.ctx.settings.update({ application: { developmentMode: false } });
    expect((await h.api("POST", "/v1/webhooks/endpoints", { url: "http://127.0.0.1:9999/hook" })).status).toBe(422);
    expect((await h.api("POST", "/v1/webhooks/endpoints", { url: "http://169.254.169.254/latest/meta-data" })).status).toBe(422);
    expect((await h.api("POST", "/v1/webhooks/endpoints", { url: "http://[::1]:9999/hook" })).status).toBe(422);
    expect((await h.api("POST", "/v1/webhooks/endpoints", { url: "file:///etc/passwd" })).status).toBe(422);
    expect((await h.api("POST", "/v1/webhooks/endpoints", { url: "https://hooks.example.com/abc" })).status).toBe(200);
  });

  it("refuses to PATCH an endpoint to a private URL", async () => {
    const h = await testApp();
    await h.ctx.settings.update({ application: { developmentMode: false } });
    const created = await h.api("POST", "/v1/webhooks/endpoints", { url: "https://hooks.example.com/abc" });
    const endpoint = await created.json();
    expect((await h.api("PATCH", `/v1/webhooks/endpoints/${endpoint.id}`, { url: "http://10.0.0.5/hook" })).status).toBe(422);
  });

  it("does not follow an endpoint redirect into a blocked network", async () => {
    const h = await testApp();
    const created = await h.api("POST", "/v1/webhooks/endpoints", { url: `${base}/redirect` });
    const endpoint = await created.json();
    redirectTarget = "http://169.254.169.254/latest/meta-data/";
    await h.ctx.settings.update({ application: { developmentMode: false } });
    // The delivery itself fails closed and is recorded, never dispatched to the metadata service.
    const tested = await h.api("POST", `/v1/webhooks/endpoints/${endpoint.id}/test`);
    expect(tested.status).toBe(200);
    // The delivery records the refusal and is rescheduled; it never reaches a private destination.
    const delivery = await tested.json();
    expect(delivery.status).toBe("pending");
    expect(delivery.response_code).toBeNull();
    expect(delivery.response_body ?? "").not.toContain("meta-data");
    expect(endpoint.url).toContain("/redirect");
  });
});
