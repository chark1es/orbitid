import { defineConfig } from "vitest/config";
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

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
  build: { outDir: "dist", sourcemap: true },
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
