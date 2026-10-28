import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { createContext } from "./bootstrap";
import type { Env } from "./env";
import { startWebhookWorker } from "./services/webhooks";
import { startAnonymousCleanupWorker } from "./services/anonymous";

export { createApp } from "./app";
export { createContext } from "./bootstrap";
export type { AppContext } from "./context";
export type { Env } from "./env";

/** Boot everything and listen. Returns a handle for tests/embedding. */
export async function startServer(overrides: Partial<Env> = {}) {
  const ctx = await createContext(overrides);
  const app = createApp(ctx);
  const stopWorker = startWebhookWorker(ctx);
  const stopAnonymousCleanup = startAnonymousCleanupWorker(ctx);
  const server = serve({ fetch: app.fetch, port: ctx.env.port });
  return { ctx, app, server, close: async () => { stopWorker(); stopAnonymousCleanup(); server.close(); await ctx.close(); } };
}
