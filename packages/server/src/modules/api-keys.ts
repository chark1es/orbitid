// OWNER: W4 machine — /v1/api_keys (backend) + /v1/client/api_keys (fapi: user/org self-service)
import { Hono } from "hono";
import type { AppContext } from "../context";

/** Any of the sub-apps may be omitted. `fapi` is mounted at /v1/client, `backend` at /v1 (secret-key guarded), `saml` at /v1/saml. */
export default function routes(_ctx: AppContext): { fapi?: Hono; backend?: Hono; saml?: Hono } {
  return {};
}
