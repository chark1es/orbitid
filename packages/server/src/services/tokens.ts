// OWNER: worker "core" (W1). Signing keys (RS256, generated on first boot, stored in signing_keys), JWKS, session JWTs.
import type { JWK } from "jose";
import type { SessionClaims } from "@orbitid/shared";
import type { AppContext } from "../context";

/** Mint a session JWT for an active session. `template`: name of jwt_templates row (claims via services/jwt-templates.renderTemplateClaims). Includes org_* claims for session.lastActiveOrganizationId. */
export async function signSessionToken(_ctx: AppContext, _sessionId: string, _opts: { template?: string; azp?: string; skipCache?: boolean } = {}): Promise<string> {
  throw new Error("not implemented (W1)");
}
export async function verifySessionToken(_ctx: AppContext, _jwt: string): Promise<SessionClaims> {
  throw new Error("not implemented (W1)");
}
/** Sign arbitrary claims with the instance key (used by OIDC id_token + JWT templates). */
export async function signJwt(_ctx: AppContext, _claims: Record<string, unknown>, _opts: { expiresInSeconds: number; audience?: string; issuer?: string; kid?: string }): Promise<string> {
  throw new Error("not implemented (W1)");
}
export async function getJwks(_ctx: AppContext): Promise<{ keys: JWK[] }> {
  throw new Error("not implemented (W1)");
}
