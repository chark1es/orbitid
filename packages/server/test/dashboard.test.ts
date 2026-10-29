import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createContext } from "../src/bootstrap";

async function appWithDashboard() {
  const dir = mkdtempSync(join(tmpdir(), "orbitid-dashboard-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<html><head><title>OrbitID</title></head><body><div id=root></div></body></html>");
  writeFileSync(join(dir, "assets", "app-abc123.js"), "console.log('dashboard')");
  const ctx = await createContext({ databaseUrl: ":memory:", secretKey: "sk_test_dash", baseUrl: "https://auth.example.com", encryptionKey: "d".repeat(40), dashboardDir: dir });
  return { ctx, app: createApp(ctx) };
}

describe("dashboard hosting", () => {
  it("serves index.html with the instance url injected, assets as immutable files, and falls back for client routes", async () => {
    const { app, ctx } = await appWithDashboard();

    const index = await app.request("/");
    expect(index.status).toBe(200);
    const html = await index.text();
    expect(html).toContain('"apiUrl":"https://auth.example.com"');
    expect(html).toContain(`"publishableKey":"${ctx.publishableKey}"`);
    expect(html).toContain(`"database":"${ctx.database.dialect}"`);

    const asset = await app.request("/assets/app-abc123.js");
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(asset.headers.get("cache-control")).toContain("immutable");

    const route = await app.request("/users/user_123");
    expect(await route.text()).toContain('id=root');
  });

  it("answers a malformed percent-escape with 400 instead of an error", async () => {
    const { app } = await appWithDashboard();
    for (const path of ["/%", "/%zz", "/assets/%E0%A4%A"]) expect((await app.request(path)).status).toBe(400);
  });

  it("never shadows the API and refuses path traversal", async () => {
    const { app } = await appWithDashboard();
    const missing = await app.request("/oauth/does-not-exist");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toContain("json");
    expect((await app.request("/v1/does-not-exist")).headers.get("content-type")).toContain("json");
    const traversal = await app.request("/..%2F..%2Fpackage.json");
    expect(await traversal.text()).not.toContain('"name"');
    const health = await (await app.request("/health")).json();
    expect(health.status).toBe("ok");
    expect(["postgres", "sqlite"]).toContain(health.database);
  });
});
