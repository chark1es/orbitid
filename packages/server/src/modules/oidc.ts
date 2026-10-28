// OWNER: W4 machine — OIDC/OAuth2 provider at /oauth/* and /.well-known/openid-configuration; mgmt /v1/oauth_applications
import { Hono } from "hono";
import type { AppContext } from "../context";

export default function routes(_ctx: AppContext) {
  const app = new Hono();
  return app;
}
