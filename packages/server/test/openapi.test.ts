import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { createContext } from "../src/bootstrap";
import { buildOpenApi } from "../src/openapi";
import { listRoutes, routeKey } from "../src/openapi/routes";

/**
 * The drift guard: the committed route inventory and the OpenAPI document must describe exactly the same surface.
 *
 * `app.routes` is the source of truth for "the server exposes this". Anything it lists must appear in the document,
 * and the document must not promise anything the server does not answer.
 */

/**
 * Paths served outside a normal API handler.
 *
 * - `GET /*` is the dashboard SPA fallback (only registered when a dashboard build exists): it answers with
 *   `index.html` for any unmatched path, which is not an API operation.
 * - `/docs` and `/docs/assets/*` and `/v1/openapi.json` are the documentation itself, documented by
 *   `src/modules/docs.ts` rather than by this spec.
 *
 * Everything else must be documented; each entry here needs a reason so the list stays a review checkpoint.
 */
const DASHBOARD_FALLBACK = "GET /*";

const isDocumentationRoute = (route: string): boolean => {
  const path = route.slice(route.indexOf(" ") + 1);
  // The device verification page's own script and stylesheet are static assets of that page, not API operations.
  return path === "/docs" || path.startsWith("/docs/") || path === "/v1/openapi.json" || path === "/oauth/device.js" || path === "/oauth/device.css";
};

async function boot() {
  const ctx = await createContext({
    databaseUrl: ":memory:",
    secretKey: "sk_test_docs",
    baseUrl: "https://auth.example.com",
    encryptionKey: "d".repeat(40),
  });
  const app = createApp(ctx);
  return { ctx, app };
}

describe("OpenAPI drift guard", () => {
  it("documents every registered route and nothing else", async () => {
    const { app } = await boot();
    const actual = new Set(listRoutes(app).map(routeKey));
    const spec = buildOpenApi({ baseUrl: "https://auth.example.com" });

    const documented = new Set<string>();
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const method of Object.keys(item)) {
        if (method === "parameters" || method === "$ref" || method === "summary" || method === "description" || method === "servers") continue;
        documented.add(`${method.toUpperCase()} ${path}`);
      }
    }

    const undocumented = [...actual].filter((route) => !documented.has(route) && route !== DASHBOARD_FALLBACK && !isDocumentationRoute(route));
    const phantom = [...documented].filter((route) => !actual.has(route) && !isDocumentationRoute(route));

    expect(undocumented, "routes missing from the OpenAPI document").toEqual([]);
    expect(phantom, "documented routes the app does not serve").toEqual([]);
  });

  it("keeps the allowlist to the dashboard fallback and the documentation routes", () => {
    expect(DASHBOARD_FALLBACK).toBe("GET /*");
    expect(isDocumentationRoute("GET /docs")).toBe(true);
    expect(isDocumentationRoute("GET /docs/assets/viewer.js")).toBe(true);
    expect(isDocumentationRoute("GET /v1/openapi.json")).toBe(true);
    expect(isDocumentationRoute("GET /v1/users")).toBe(false);
    expect(isDocumentationRoute("GET /docsomething")).toBe(false);
  });

  it("serves a self-contained docs page that works under a strict CSP", async () => {
    const { app } = await boot();

    const page = await app.request("/docs");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const csp = page.headers.get("content-security-policy");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");

    const html = await page.text();
    expect(html).toContain("/docs/assets/viewer.js");
    expect(html).toContain("/docs/assets/viewer.css");
    // No inline handlers and no inline script/style: they would need 'unsafe-inline'.
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(html).not.toMatch(/<style/i);
    // No CDN or other third-party origin.
    expect(html).not.toMatch(/https?:\/\//);

    const js = await app.request("/docs/assets/viewer.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
    const jsBody = await js.text();
    expect(jsBody).toContain("/v1/openapi.json");
    expect(jsBody).not.toContain("eval(");
    expect(jsBody).not.toContain("new Function");
    expect(jsBody).not.toMatch(/\.innerHTML\s*=/);
    // No third-party resources: every request the page makes stays on this origin.
    expect(jsBody).not.toMatch(/(fetch|importScripts|import)\s*\(\s*["']https?:/i);
    expect(jsBody).not.toMatch(/createElement\(\s*["']script["']\s*\)/);

    const css = await app.request("/docs/assets/viewer.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(await css.text()).toContain("--signal");

    // The docs and the spec are public: no cookie, no key required.
    for (const path of ["/docs", "/docs/assets/viewer.js", "/docs/assets/viewer.css", "/v1/openapi.json"]) {
      const response = await app.request(path);
      expect(response.status, path).toBe(200);
    }
  });

  it("serves the viewer's module graph from the same origin", async () => {
    const { app } = await boot();
    const html = await (await app.request("/docs")).text();
    expect(html).toContain('type="module"');

    // Walk every relative import the browser would follow, starting at the entry module.
    const origin = "https://auth.example.com";
    const modules = new Map<string, string>();
    const queue = [new URL("/docs/assets/viewer.js", origin)];
    while (queue.length) {
      const url = queue.shift() as URL;
      if (modules.has(url.pathname)) continue;

      const response = await app.request(url.pathname);
      expect(response.status, url.pathname).toBe(200);
      expect(response.headers.get("content-type"), url.pathname).toContain("javascript");
      expect(response.headers.get("content-security-policy"), url.pathname).toContain("script-src 'self'");
      const body = await response.text();
      modules.set(url.pathname, body);

      for (const match of body.matchAll(/(?:from\s+|import\s*\()\s*["']([^"']+)["']/g)) {
        const specifier = match[1];
        expect(specifier.startsWith("."), `${url.pathname} imports non-relative ${specifier}`).toBe(true);
        queue.push(new URL(specifier, url));
      }
    }

    // The viewer is split into several modules; the route table must have picked all of them up.
    expect(modules.size).toBeGreaterThan(3);
    for (const [path, body] of modules) {
      expect(body, path).not.toContain("eval(");
      expect(body, path).not.toContain("new Function");
      expect(body, path).not.toMatch(/\.innerHTML\s*=/);
      expect(body, path).not.toMatch(/(fetch|importScripts)\s*\(\s*["']https?:/i);
    }
    // An unknown module is still a JSON 404, never a directory listing or the SPA fallback.
    const missing = await app.request("/docs/assets/viewer/nope.js");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toContain("application/json");
  });

  it("is not swallowed by the dashboard catch-all", async () => {
    // Same setup as the dashboard tests: a built SPA that answers index.html for any path.
    const dir = mkdtempSync(join(tmpdir(), "orbitid-docs-dashboard-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<html><body><div id=root></div></body></html>");
    const ctx = await createContext({
      databaseUrl: ":memory:",
      secretKey: "sk_test_docs",
      baseUrl: "https://auth.example.com",
      encryptionKey: "d".repeat(40),
      dashboardDir: dir,
    });
    const app = createApp(ctx);

    for (const path of ["/docs", "/docs/assets/viewer.js", "/v1/openapi.json"]) {
      const response = await app.request(path);
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).not.toContain('id=root');
    }
    // An unknown docs path is a JSON 404 from the API, not the SPA fallback.
    const missing = await app.request("/docs/nope.js");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toContain("application/json");
    // The dashboard still serves its own routes.
    expect(await (await app.request("/users/user_123")).text()).toContain("id=root");
  });
});
