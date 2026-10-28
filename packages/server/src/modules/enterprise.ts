// OWNER: W4 machine — SAML + enterprise OIDC SSO: backend=/v1/enterprise_connections, fapi=/v1/client/enterprise/*, saml=/v1/saml/:id/{acs,metadata,sso}
import { Hono } from "hono";
import type { AppContext } from "../context";

/** Any of the sub-apps may be omitted. `fapi` is mounted at /v1/client, `backend` at /v1 (secret-key guarded), `saml` at /v1/saml. */
export default function routes(_ctx: AppContext): { fapi?: Hono; backend?: Hono; saml?: Hono } {
  return {};
}
