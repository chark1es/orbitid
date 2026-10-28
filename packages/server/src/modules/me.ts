// OWNER: W1 core — /v1/client/me (profile, password, emails, phones, external accounts, totp, backup codes, passkeys, sessions, image, delete)
import { Hono } from "hono";
import type { AppContext } from "../context";

export default function routes(_ctx: AppContext) {
  const app = new Hono();
  return app;
}
