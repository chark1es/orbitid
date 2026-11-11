// RP-initiated logout (`end_session_endpoint`): validate id_token_hint and the post-logout return URI, end the
// browser session the grant came from, and revoke the tokens minted from it.
import { compactVerify, createLocalJWKSet, decodeJwt } from "jose";
import { eq } from "drizzle-orm";
import type { AppContext } from "../../context";
import * as s from "../../db/schema";
import { first } from "../../lib/db";
import { getJwks } from "../tokens";
import { endSession } from "../sessions";
import { assertPostLogoutRedirectUri, getApplication, getApplicationByClientId } from "./applications";
import { OAuthError, type ApplicationRow } from "./shared";
import { revokeGrantsForSession } from "./tokens";

export interface LogoutInput {
  idTokenHint?: string;
  clientId?: string;
  postLogoutRedirectUri?: string;
  state?: string;
  /** Public issuer used to validate the hint; the caller derives it from trusted forwarded headers. */
  issuer?: string;
}

export interface LogoutResult {
  redirectTo: string;
  application: ApplicationRow | null;
  sessionId: string | null;
}

interface HintClaims {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  azp?: string;
  sid?: string;
}

/** Verifies the signature (not the expiry: an expired hint is still valid for logout) and returns its claims. */
async function verifyHint(ctx: AppContext, hint: string, issuer: string): Promise<HintClaims> {
  try {
    await compactVerify(hint, createLocalJWKSet(await getJwks(ctx)), { algorithms: ["RS256"] });
  } catch {
    throw new OAuthError(400, "invalid_request", "id_token_hint is not a token signed by this instance");
  }
  const claims = decodeJwt(hint) as HintClaims;
  if (claims.iss !== issuer) throw new OAuthError(400, "invalid_request", "id_token_hint was issued by another issuer");
  return claims;
}

/**
 * `GET/POST /oauth/end_session`. A redirect is returned only after the return URI is matched against the
 * application's registered `post_logout_redirect_uris`; an unregistered URI is refused instead of redirected.
 */
export async function endSessionAtProvider(ctx: AppContext, input: LogoutInput): Promise<LogoutResult> {
  const claims = input.idTokenHint ? await verifyHint(ctx, input.idTokenHint, input.issuer ?? ctx.env.baseUrl) : null;
  let application: ApplicationRow | null = null;
  if (claims) {
    const audience = Array.isArray(claims.aud) ? claims.aud[0] : claims.aud;
    if (input.clientId && audience !== input.clientId) {
      throw new OAuthError(400, "invalid_request", "client_id does not match the id_token_hint audience");
    }
    if (claims.azp && audience && claims.azp !== audience) {
      throw new OAuthError(400, "invalid_request", "id_token_hint azp does not match its audience");
    }
    if (audience) application = await getApplicationByClientId(ctx, audience);
  } else if (input.clientId) {
    application = await getApplicationByClientId(ctx, input.clientId);
    if (!application) throw new OAuthError(400, "invalid_request", "Unknown client_id");
  }

  let redirectTo = ctx.settings.get().application.homeUrl;
  if (input.postLogoutRedirectUri) {
    if (!application) throw new OAuthError(400, "invalid_request", "client_id or id_token_hint is required with post_logout_redirect_uri");
    redirectTo = assertPostLogoutRedirectUri(application, input.postLogoutRedirectUri);
  }

  const sessionId = typeof claims?.sid === "string" ? claims.sid : null;
  if (sessionId && claims?.sub) {
    const session = first(await ctx.db.select().from(s.sessions).where(eq(s.sessions.id, sessionId)));
    // Only end a session the hint actually describes; a hint for another user must not sign this one out.
    if (session && session.userId === claims.sub) {
      await endSession(ctx, session, "ended");
      await revokeGrantsForSession(ctx, sessionId);
    }
  }

  if (input.postLogoutRedirectUri && input.state) {
    const url = new URL(redirectTo);
    url.searchParams.set("state", input.state);
    redirectTo = url.toString();
  }
  return { redirectTo, application, sessionId };
}
