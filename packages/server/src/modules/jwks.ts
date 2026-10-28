// GET /.well-known/jwks.json (+ /v1/jwks)
import { Hono, type Context } from "hono";
import type { AppContext } from "../context";
import { getJwks } from "../services/tokens";

export default function routes(ctx: AppContext) {
  const app = new Hono();
  const handler = async (c: Context) => {
    c.header("Cache-Control", "public, max-age=300");
    return c.json(await getJwks(ctx));
  };
  app.get("/.well-known/jwks.json", handler);
  app.get("/v1/jwks", handler);
  return app;
}
