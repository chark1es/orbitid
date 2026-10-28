// RelayState / `state` storage for enterprise SSO flows (SAML and enterprise OIDC).
import { eq } from "drizzle-orm";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import type { AppContext } from "../../context";
import { oauthStates } from "../../db/schema";
import { randomToken } from "../../lib/crypto";

export const ENTERPRISE_STATE_TTL_MS = 10 * 60 * 1000;

/** What a completed SSO assertion should do: the shape `handleExternalIdentity` expects, plus the connection id. */
export interface EnterpriseFlow {
  kind: "sign_in" | "sign_up" | "connect";
  clientId: string;
  ownerId?: string;
  userId?: string;
  redirectUrl: string;
  actionCompleteRedirectUrl?: string;
  connectionId: string;
}

export function createEnterpriseState(
  ctx: AppContext,
  input: { provider: string; flow: EnterpriseFlow; codeVerifier?: string | null; nonce?: string | null },
): string {
  const state = randomToken(24);
  ctx.db.insert(oauthStates).values({
    state,
    provider: input.provider,
    codeVerifier: input.codeVerifier ?? null,
    nonce: input.nonce ?? null,
    flow: input.flow as unknown as Record<string, unknown>,
    expiresAt: Date.now() + ENTERPRISE_STATE_TTL_MS,
  }).run();
  return state;
}

export interface EnterpriseState {
  flow: EnterpriseFlow;
  codeVerifier: string | null;
  nonce: string | null;
}

/** Reads and deletes a state row (single use). Returns null for unknown, expired or provider-mismatched states. */
export function takeEnterpriseState(ctx: AppContext, state: string, provider: string): EnterpriseState | null {
  if (!state) return null;
  const row = ctx.db.select().from(oauthStates).where(eq(oauthStates.state, state)).get();
  if (!row || row.provider !== provider) return null;
  ctx.db.delete(oauthStates).where(eq(oauthStates.state, state)).run();
  if (row.expiresAt <= Date.now()) return null;
  return { flow: row.flow as unknown as EnterpriseFlow, codeVerifier: row.codeVerifier, nonce: row.nonce };
}

/** Reads a state row without consuming it (used for `GET /v1/saml/:id/sso?flow=…`). */
export function peekEnterpriseState(ctx: AppContext, state: string, provider: string): EnterpriseState | null {
  if (!state) return null;
  const row = ctx.db.select().from(oauthStates).where(eq(oauthStates.state, state)).get();
  if (!row || row.provider !== provider || row.expiresAt <= Date.now()) return null;
  return { flow: row.flow as unknown as EnterpriseFlow, codeVerifier: row.codeVerifier, nonce: row.nonce };
}

/** Redirect targets must belong to a configured origin (open-redirect protection). */
export function assertAllowedRedirectUrl(ctx: AppContext, url: string, param = "redirect_url"): string {
  const app = ctx.settings.get().application;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new OrbitError(422, ErrorCodes.form_param_format_invalid, `${param} is not a valid URL`, { param_name: param });
  }
  const origins = [app.homeUrl, ...app.allowedOrigins, ...app.allowedRedirectOrigins].flatMap((value) => {
    try { return [new URL(value).origin]; } catch { return []; }
  });
  const devLocalhost = app.developmentMode && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(parsed.origin);
  if (!origins.includes(parsed.origin) && !devLocalhost) {
    throw new OrbitError(422, ErrorCodes.form_param_value_invalid, `${param} origin is not allowed`, { param_name: param });
  }
  return url;
}
