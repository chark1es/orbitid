// OWNER: worker "core" (W1). Shared by social OAuth (W1) and enterprise SAML/OIDC (W4).
import type { AppContext } from "../context";

export interface ExternalProfile {
  provider: string; // "google" | "github" | "saml_<connId>" | "oidc_<connId>"
  providerUserId: string;
  email?: string; emailVerified?: boolean;
  firstName?: string; lastName?: string; username?: string; imageUrl?: string;
  accessToken?: string; refreshToken?: string; expiresAt?: number; scopes?: string;
  raw?: Record<string, unknown>;
}
/**
 * Resolve an authenticated external identity inside a client's flow.
 *  - Existing external_account → complete the sign-in (creates session, handles MFA requirement → needs_second_factor).
 *  - Verified email matches an existing user → link & sign in (per settings).
 *  - Otherwise → create/advance sign_up (transferable) and complete if requirements satisfied.
 * `flow.kind === "connect"` links to flow.userId instead. Returns the redirect URL the browser should be sent to.
 */
export async function handleExternalIdentity(_ctx: AppContext, _flow: { clientId: string; kind: "sign_in" | "sign_up" | "connect"; ownerId?: string; userId?: string; redirectUrl: string; actionCompleteRedirectUrl?: string }, _profile: ExternalProfile):
  Promise<{ redirectTo: string }> {
  throw new Error("not implemented (W1)");
}
