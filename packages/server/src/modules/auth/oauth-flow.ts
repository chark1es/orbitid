// OWNER: worker "core" (W1). Starts an OAuth authorization and persists its state.
import { generateCodeVerifier, generateState } from "arctic";
import { eq } from "drizzle-orm";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import type { AppContext } from "../../context";
import * as s from "../../db/schema";
import { getOAuthAdapter, providerConfig } from "../../services/oauth-providers";

export interface OAuthFlow {
  clientId: string;
  kind: "sign_in" | "sign_up" | "connect";
  ownerId?: string;
  userId?: string;
  redirectUrl: string;
  actionCompleteRedirectUrl?: string;
  additionalScopes?: string[];
}

const STATE_TTL_MS = 10 * 60_000;

/** Builds the provider authorization URL and stores PKCE/state → flow. */
export async function createOAuthAuthorization(ctx: AppContext, provider: string, flow: OAuthFlow): Promise<{ url: string; state: string }> {
  const cfg = providerConfig(ctx, provider);
  if (!cfg) throw new OrbitError(400, ErrorCodes.oauth_provider_not_enabled, `Social provider "${provider}" is not enabled`, { param_name: "strategy" });
  const adapter = await getOAuthAdapter(ctx, provider);
  if (!adapter) throw new OrbitError(400, ErrorCodes.oauth_provider_not_enabled, `Social provider "${provider}" is not supported`, { param_name: "strategy" });
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const scopes = [...cfg.scopes, ...(flow.additionalScopes ?? [])].filter((v, i, arr) => arr.indexOf(v) === i);
  const url = await adapter.createAuthorizationUrl({ state, codeVerifier, scopes });
  ctx.db.insert(s.oauthStates).values({
    state,
    provider,
    codeVerifier,
    nonce: null,
    flow: { ...flow, additionalScopes: flow.additionalScopes ?? [] },
    expiresAt: Date.now() + STATE_TTL_MS,
  }).run();
  return { url: url.toString(), state };
}

export interface StoredOAuthFlow extends OAuthFlow { provider: string; codeVerifier: string }

export function takeOAuthState(ctx: AppContext, state: string, provider: string): StoredOAuthFlow {
  const row = ctx.db.select().from(s.oauthStates).where(eq(s.oauthStates.state, state)).get();
  if (!row || row.provider !== provider || row.expiresAt <= Date.now()) {
    if (row && row.expiresAt <= Date.now()) ctx.db.delete(s.oauthStates).where(eq(s.oauthStates.state, state)).run();
    throw new OrbitError(400, ErrorCodes.oauth_callback_error, "The OAuth state is invalid or has expired");
  }
  ctx.db.delete(s.oauthStates).where(eq(s.oauthStates.state, state)).run();
  // Persisted JSON: the row is written only by createOAuthAuthorization above.
  const flow = row.flow as unknown as OAuthFlow;
  return { ...flow, provider: row.provider, codeVerifier: row.codeVerifier ?? "" };
}
