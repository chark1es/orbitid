// OWNER: W3 admin — Backend API: /v1/webhooks/*
import { Hono } from "hono";
import type { AppContext } from "../context";

export default function routes(_ctx: AppContext) {
  const app = new Hono();
  return app;
}
