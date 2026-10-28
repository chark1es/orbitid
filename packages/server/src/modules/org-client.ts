// OWNER: W2 orgs — Frontend API organizations (mounted at /v1/client)
import { Hono } from "hono";
import type { AppContext } from "../context";

export default function routes(_ctx: AppContext) {
  const app = new Hono();
  return app;
}
