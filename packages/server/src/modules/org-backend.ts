// OWNER: W2 orgs — Backend API organizations, memberships, invitations, domains, roles, permissions (mounted at /v1)
import { Hono } from "hono";
import type { AppContext } from "../context";

export default function routes(_ctx: AppContext) {
  const app = new Hono();
  return app;
}
