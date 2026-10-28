// OWNER: W3 admin — Backend API: users, sessions, clients, actor/sign-in tokens, invitations, allow/blocklist, waitlist, jwt templates, instance, testing tokens, audit logs (mounted at /v1)
import { Hono } from "hono";
import type { AppContext } from "../context";

export default function routes(_ctx: AppContext) {
  const app = new Hono();
  return app;
}
