import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants as zlib, gzipSync } from "node:zlib";
import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * The dashboard is same-origin with the instance it manages: the operator session cookie is httpOnly,
 * `SameSite=Strict` and `Path=/v1`, and the server accepts it only from its own origin. In development the
 * Vite server therefore proxies the API instead of calling a second origin, and rewrites `Origin`/`Referer`
 * to the proxy target so the server sees a genuine same-origin request. The alternative would be to trust
 * arbitrary `localhost` ports in production code, which is exactly the fallback the server refuses.
 *
 * `ORBITID_DEV_API_URL` moves the proxy target when the server is not on the default port; it must match the
 * server's `ORBITID_BASE_URL` for the rewrite to satisfy the origin check.
 */
const apiTarget = (process.env.ORBITID_DEV_API_URL ?? "http://localhost:4000").replace(/\/+$/, "");

/** Rewrites the browser-facing origin to the API origin before the request leaves the dev server. */
function sameOriginProxy() {
  return {
    target: apiTarget,
    changeOrigin: true,
    configure: (proxy: { on: (event: string, handler: (proxyReq: { setHeader: (name: string, value: string) => void }) => void) => void }) => {
      proxy.on("proxyReq", (proxyReq) => {
        proxyReq.setHeader("origin", apiTarget);
        proxyReq.setHeader("referer", `${apiTarget}/`);
      });
    },
  };
}

/**
 * Writes `.br` and `.gz` next to every text asset in the build. The OrbitID server serves the smallest one the
 * browser accepts, so the dashboard ships about a third of its raw size without compressing per request.
 * `index.html` is skipped: the server rewrites it on every request (CSP nonce, instance bootstrap).
 */
function precompress(): Plugin {
  const compressible = /\.(js|mjs|css|svg|json|txt|html)$/;
  return {
    name: "orbitid-precompress",
    apply: "build",
    closeBundle() {
      const root = join(import.meta.dirname, "dist");
      const walk = (dir: string): string[] =>
        readdirSync(dir).flatMap((name) => {
          const path = join(dir, name);
          return statSync(path).isDirectory() ? walk(path) : [path];
        });
      for (const file of walk(root)) {
        if (!compressible.test(file) || file === join(root, "index.html")) continue;
        const source = readFileSync(file);
        if (source.length < 1024) continue;
        writeFileSync(`${file}.br`, brotliCompressSync(source, { params: { [zlib.BROTLI_PARAM_QUALITY]: 11 } }));
        writeFileSync(`${file}.gz`, gzipSync(source, { level: 9 }));
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), precompress()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/v1": sameOriginProxy(),
      "/health": sameOriginProxy(),
      // Anchored so the dashboard's own `/oauth-apps` route is not proxied to the API in dev.
      "^/oauth/": sameOriginProxy(),
      "/.well-known": sameOriginProxy(),
      "/docs": sameOriginProxy(),
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    rollupOptions: {
      output: {
        // The framework changes far less often than the dashboard. A separate chunk stays cached across upgrades.
        manualChunks(id) {
          if (/node_modules\/(react|react-dom|scheduler|react-router|@tanstack)\//.test(id)) return "framework";
          return undefined;
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    css: false,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // The workspace suites run side by side; give slow UI interactions room so load does not cause false failures.
    testTimeout: 20_000,
  },
});
