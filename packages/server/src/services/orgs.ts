// OWNER: worker "orgs" (W2).
import type { AppContext } from "../context";

/** Role + permissions for user in org, or null if not a member. Used when minting session JWTs (org_id, org_role, org_permissions, org_slug). */
export async function getMembershipContext(_ctx: AppContext, _userId: string, _orgId: string): Promise<null | { orgId: string; slug: string | null; role: string; permissions: string[] }> {
  throw new Error("not implemented (W2)");
}
/** Called by core after a user (with a freshly verified email) is created or verifies an email: accept pending org invitations for that email, apply verified-domain automatic_invitation/automatic_suggestion. */
export async function onUserEmailVerified(_ctx: AppContext, _userId: string, _email: string): Promise<void> {}
/** Called when a sign-up completes with an org invitation ticket. */
export async function acceptInvitationByTicket(_ctx: AppContext, _ticket: string, _userId: string): Promise<void> {}
/** Seed system roles (org:admin, org:member) + system permissions. Idempotent. Called at boot by bootstrap. */
export async function seedRbac(_ctx: AppContext): Promise<void> {}
/** Remove memberships/invitations/requests of a deleted user; promote/delete orgs left without admins as per docs. */
export async function onUserDeleted(_ctx: AppContext, _userId: string): Promise<void> {}
