// OWNER: W3 admin — Frontend API: POST /v1/client/waitlist
import { Hono } from "hono";
import type { AppContext } from "../context";

export default function routes(_ctx: AppContext) {
  const app = new Hono();
  return app;
}
