// OWNER: W1 core — GET /.well-known/jwks.json (+ /v1/jwks)
import { Hono } from "hono";
import type { AppContext } from "../context";

export default function routes(_ctx: AppContext) {
  const app = new Hono();
  return app;
}
