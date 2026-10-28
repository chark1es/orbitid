// OWNER: W1 core — social OAuth: /v1/oauth_callback/:provider (+ start helpers)
import { Hono } from "hono";
import type { AppContext } from "../context";

export default function routes(_ctx: AppContext) {
  const app = new Hono();
  return app;
}
