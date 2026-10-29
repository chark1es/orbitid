import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import type { Context } from "hono";
import type { AppContext } from "../context";
import { cspNonce, dashboardCsp } from "../lib/security";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".woff": "font/woff", ".txt": "text/plain; charset=utf-8", ".map": "application/json", ".webp": "image/webp",
};

/** Paths that belong to the API, never to the dashboard. */
const API_PREFIXES = ["/v1", "/oauth", "/.well-known", "/health", "/docs"];

/** Adds the nonce to every inline `<script>` of the built page (external `src` scripts stay as they are). */
function withNonce(html: string, nonce: string): string {
  return html.replace(/<script(?![^>]*\bsrc=)([^>]*)>/gi, (match, rest: string) => {
    if (/\bnonce=/i.test(rest)) return match;
    return `<script nonce="${nonce}"${rest}>`;
  });
}

/**
 * Serves the built dashboard (a single-page app) from `env.dashboardDir`. `index.html` gets the instance's
 * public URL and database engine injected, so a dashboard on the same origin needs no configuration.
 * Returns undefined when no build exists, which leaves the server API-only.
 */
export function dashboardHandler(ctx: AppContext): ((c: Context) => Response | Promise<Response>) | undefined {
  const root = ctx.env.dashboardDir;
  const indexPath = join(root, "index.html");
  if (!existsSync(indexPath)) return undefined;

  const bootstrap = (nonce: string) =>
    `<script nonce="${nonce}">window.__ORBITID__=${JSON.stringify({ apiUrl: ctx.env.baseUrl, publishableKey: ctx.publishableKey, database: ctx.database.dialect })}</script>`;
  const indexHtml = () => {
    const nonce = cspNonce();
    const html = withNonce(readFileSync(indexPath, "utf8"), nonce).replace("</head>", `${bootstrap(nonce)}</head>`);
    return { html, nonce };
  };

  return (c) => {
    let path: string;
    try {
      path = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return c.text("Bad request", 400);
    }
    if (API_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return c.notFound();
    const candidate = normalize(join(root, path));
    if (candidate.startsWith(root + sep) && existsSync(candidate) && statSync(candidate).isFile() && candidate !== indexPath) {
      const immutable = path.startsWith("/assets/");
      return new Response(readFileSync(candidate), {
        headers: { "content-type": MIME[extname(candidate)] ?? "application/octet-stream", "cache-control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=300" },
      });
    }
    const { html, nonce } = indexHtml();
    return c.html(html, 200, {
      "cache-control": "no-cache",
      "content-security-policy": dashboardCsp(ctx, nonce),
      "x-frame-options": "DENY",
    });
  };
}
