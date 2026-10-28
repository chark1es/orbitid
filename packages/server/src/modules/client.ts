// OWNER: W1 core — /v1/client (client, sessions, tokens, touch/end/remove)
import { Hono } from "hono";
import type { AppContext } from "../context";

export default function routes(_ctx: AppContext) {
  const app = new Hono();
  return app;
}
