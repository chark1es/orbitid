// OWNER: worker "admin" (W3) — Backend API: users, sessions, clients, actor/sign-in tokens, invitations, allow/blocklist, waitlist, jwt templates, instance, testing tokens, audit logs (mounted at /v1)
import { Hono } from "hono";
import type { AppContext } from "../context";
import users from "./admin/users";
import identifiers from "./admin/identifiers";
import sessions from "./admin/sessions";
import tokens from "./admin/tokens";
import invitations from "./admin/invitations";
import waitlist from "./admin/waitlist";
import jwtTemplates from "./admin/jwt";
import instance from "./admin/instance";

export default function routes(ctx: AppContext) {
  const app = new Hono();
  app.route("/", users(ctx));
  app.route("/", identifiers(ctx));
  app.route("/", sessions(ctx));
  app.route("/", tokens(ctx));
  app.route("/", invitations(ctx));
  app.route("/", waitlist(ctx));
  app.route("/", jwtTemplates(ctx));
  app.route("/", instance(ctx));
  return app;
}
