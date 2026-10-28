import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { createContext } from "../../src/bootstrap";
import { setup, testClient } from "../core/helpers";

async function appWithDashboard() {
  const dir = mkdtempSync(join(tmpdir(), "orbitid-security-dashboard-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(
    join(dir, "index.html"),
    `<html><head><title>OrbitID</title><script>window.__theme="dark"</script></head><body><div id=root></div></body></html>`,
  );
  writeFileSync(join(dir, "assets", "app-abc123.js"), "console.log('dashboard')");
  const ctx = await createContext({
    databaseUrl: ":memory:", secretKey: "sk_test_dash", baseUrl: "https://auth.example.com",
    encryptionKey: "d".repeat(40), dashboardDir: dir,
  });
  return { ctx, app: createApp(ctx) };
}

describe("response headers", () => {
  it("sets the baseline hardening headers on every response", async () => {
    const { app } = await setup();
    for (const path of ["/health", "/v1/client/environment", "/v1/client", "/nope"]) {
      const res = await app.request(path);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      const permissions = res.headers.get("permissions-policy") ?? "";
      for (const feature of ["camera=()", "microphone=()", "geolocation=()"]) expect(permissions).toContain(feature);
    }
  });

  it("sends HSTS only when the instance is served over https", async () => {
    const http = await setup();
    expect((await http.app.request("/health")).headers.get("strict-transport-security")).toBeNull();

    const secure = await setup({ baseUrl: "https://auth.example.com", encryptionKey: "k".repeat(40) });
    expect((await secure.app.request("/health")).headers.get("strict-transport-security")).toContain("max-age=31536000");
  });

  it("marks JSON API responses no-store unless the route chose a policy", async () => {
    const { app, ctx } = await setup();
    const client = testClient(app);
    const me = await client.request("/v1/client");
    expect(me.headers.get("cache-control")).toBe("no-store");

    // The environment is deliberately cacheable and keeps its own policy.
    const environment = await app.request("/v1/client/environment");
    expect(environment.headers.get("cache-control")).toBe("public, max-age=60");
    expect(ctx.database.dialect).toBeTruthy();
  });

  it("serves the dashboard with a nonce-based CSP whose nonce matches the inline script", async () => {
    const { app } = await appWithDashboard();
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("img-src 'self' data: https:");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");

    const nonce = /'nonce-([A-Za-z0-9_-]+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    // Every inline script carries the header's nonce (the theme bootstrap and the injected instance config).
    const inline = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].filter((m) => !/\bsrc=/.test(m[1]!));
    expect(inline.length).toBeGreaterThanOrEqual(2);
    for (const match of inline) expect(match[1]).toContain(`nonce="${nonce}"`);
    expect(html).toContain(`window.__ORBITID__=`);
    expect(html).toContain(`"publishableKey"`);

    // External scripts are never given a nonce (that would let an injected same-origin bundle run).
    expect(html).not.toMatch(/<script[^>]*\bsrc="[^"]*"[^>]*nonce=/);
  });

  it("gives each dashboard load a fresh nonce", async () => {
    const { app } = await appWithDashboard();
    const first = /'nonce-([A-Za-z0-9_-]+)'/.exec((await app.request("/")).headers.get("content-security-policy") ?? "")?.[1];
    const second = /'nonce-([A-Za-z0-9_-]+)'/.exec((await app.request("/")).headers.get("content-security-policy") ?? "")?.[1];
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first).not.toBe(second);
  });

  it("allows an extra dashboard API origin only when the operator configures one", async () => {
    const { app } = await appWithDashboard();
    process.env.ORBITID_DASHBOARD_CONNECT_SRC = "https://api.example.com";
    try {
      const csp = (await app.request("/")).headers.get("content-security-policy") ?? "";
      expect(csp).toContain("connect-src 'self' https://api.example.com");
    } finally {
      delete process.env.ORBITID_DASHBOARD_CONNECT_SRC;
    }
  });
});
