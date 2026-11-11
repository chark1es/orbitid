// A real OrbitID HTTP server on a loopback port, for relying-party packages that insist on talking HTTP.
import { createServer } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { createApp } from "../../src/app";
import { createContext } from "../../src/bootstrap";
import type { AppContext } from "../../src/context";

export const SECRET_KEY = "sk_test_oidc_interop";

const freePort = () => new Promise<number>((resolve, reject) => {
  const srv = createServer();
  srv.listen(0, "127.0.0.1", () => {
    const { port } = srv.address() as { port: number };
    srv.close(() => resolve(port));
  });
  srv.on("error", reject);
});

export interface OidcTestServer {
  ctx: AppContext;
  app: ReturnType<typeof createApp>;
  baseUrl: string;
  secret: string;
  close(): Promise<void>;
}

export async function startOidcServer(overrides: { baseUrl?: string; trustProxy?: number } = {}): Promise<OidcTestServer> {
  const port = await freePort();
  const baseUrl = overrides.baseUrl ?? `http://127.0.0.1:${port}`;
  const ctx = await createContext({
    databaseUrl: ":memory:",
    secretKey: SECRET_KEY,
    baseUrl,
    trustProxy: overrides.trustProxy ?? 0,
  });
  const app = createApp(ctx);
  const server: ServerType = await new Promise((resolve, reject) => {
    const instance = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => resolve(instance));
    instance.on("error", reject);
  });
  return {
    ctx,
    app,
    baseUrl,
    secret: SECRET_KEY,
    async close() {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      await ctx.close();
    },
  };
}
