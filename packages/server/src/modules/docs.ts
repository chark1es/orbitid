/**
 * `GET /docs` and `GET /v1/openapi.json`.
 *
 * The spec is generated from `src/openapi` at request time (it is cheap and always matches the code). The docs page
 * is a single HTML file plus a stylesheet and a small JavaScript module graph served from `/docs/assets/*`, so it works
 * under a strict CSP with `script-src 'self'` and `style-src 'self'`: no CDN, no inline handlers, no `eval`.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppContext } from "../context";
import { buildOpenApi } from "../openapi";
import { DOCS_ASSETS, DOCS_HTML } from "./docs-assets/assets";

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
};

export default function routes(ctx: AppContext) {
  const app = new Hono();

  app.get("/v1/openapi.json", (c) => {
    // Public and identical for every caller: cache it, but let a deploy invalidate quickly.
    c.header("cache-control", "public, max-age=300");
    c.header("x-content-type-options", "nosniff");
    return c.json(buildOpenApi({ baseUrl: ctx.env.baseUrl }));
  });

  app.get("/docs", (c: Context) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.header(name, value);
    c.header("cache-control", "public, max-age=300");
    return c.html(DOCS_HTML);
  });

  for (const [name, asset] of Object.entries(DOCS_ASSETS)) {
    app.get(`/docs/assets/${name}`, (c) => {
      for (const [header, value] of Object.entries(SECURITY_HEADERS)) c.header(header, value);
      c.header("cache-control", "public, max-age=300");
      return c.body(asset.body, 200, { "content-type": asset.contentType });
    });
  }

  return app;
}
