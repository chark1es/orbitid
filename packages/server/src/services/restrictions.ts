// Sign-up gating (mode/allowlist/blocklist/waitlist/invitations) + one-time tickets.
import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { ErrorCodes, OrbitError, type InvitationJSON } from "@orbitid/shared";
import { sha256 } from "../lib/crypto";
import * as s from "../db/schema";
import type { AppContext } from "../context";
import { emitEvent } from "./webhooks";
import { first } from "../lib/db";

export interface IdentifiersToCheck { emails?: string[]; phones?: string[]; invitationTicket?: string | null }

export type TicketGrant =
  | { kind: "sign_in_token"; userId: string }
  | { kind: "actor_token"; userId: string; actor: Record<string, unknown>; sessionMaxDurationSeconds: number }
  | { kind: "invitation"; invitationId: string; email: string; publicMetadata: Record<string, unknown> };

/** Frequently abused throwaway providers; only consulted when `settings.restrictions.blockDisposableEmailDomains`. */
export const DISPOSABLE_EMAIL_DOMAINS: Record<string, true> = {
  "10minutemail.com": true, "20minutemail.com": true, "33mail.com": true, "burnermail.io": true, "discard.email": true, "dispostable.com": true,
  "emailfake.com": true, "emailondeck.com": true, "eyepaste.com": true, "fake-mail.net": true, "fakeinbox.com": true, "generator.email": true,
  "getairmail.com": true, "getnada.com": true, "grr.la": true, "guerrillamail.biz": true, "guerrillamail.com": true, "guerrillamail.de": true,
  "guerrillamail.info": true, "guerrillamail.net": true, "guerrillamail.org": true, "guerrillamailblock.com": true, "harakirimail.com": true,
  "inboxbear.com": true, "klzlk.com": true, "luxusmail.org": true, "mail-temp.com": true, "mailcatch.com": true, "maildrop.cc": true,
  "mailforspam.com": true, "mailinator.com": true, "mailinator2.com": true, "mailnesia.com": true, "mailsac.com": true, "mintemail.com": true,
  "moakt.com": true, "mohmal.com": true, "mytemp.email": true, "notmailinator.com": true, "reallymymail.com": true, "sharklasers.com": true,
  "sogetthis.com": true, "spam.la": true, "spam4.me": true, "spamfree24.org": true, "spamgourmet.com": true, "spamhereplease.com": true,
  "temp-mail.org": true, "tempail.com": true, "tempmail.com": true, "tempmailo.com": true, "tempsky.com": true, "temporarymail.com": true,
  "thisisnotmyrealemail.com": true, "throwaway.email": true, "throwawaymail.com": true, "trash-mail.com": true, "trashmail.com": true,
  "wegwerfemail.de": true, "yopmail.com": true,
};

const normalizeEmail = (value: string) => value.trim().toLowerCase();
const normalizePhone = (value: string) => value.trim();
const emailDomain = (email: string) => email.slice(email.lastIndexOf("@") + 1);

/** `@example.com` / `*@example.com` match every address on the domain. */
function identifierMatches(identifier: string, email: string | null, phone: string | null): boolean {
  const id = identifier.trim().toLowerCase();
  if (email) {
    if (id === email) return true;
    if (id.startsWith("*@") && emailDomain(email) === id.slice(2)) return true;
    if (id.startsWith("@") && emailDomain(email) === id.slice(1)) return true;
  }
  if (phone && normalizePhone(id) === phone) return true;
  return false;
}

async function allowlistMatches(ctx: AppContext, emails: string[], phones: string[]): Promise<boolean> {
  const rows = (await ctx.db.select().from(s.allowlistIdentifiers));
  return rows.some((row) => emails.some((e) => identifierMatches(row.identifier, e, null)) || phones.some((p) => identifierMatches(row.identifier, null, p)));
}

async function blocklistMatches(ctx: AppContext, emails: string[], phones: string[]): Promise<string | null> {
  const rows = (await ctx.db.select().from(s.blocklistIdentifiers));
  for (const row of rows) {
    if (emails.some((e) => identifierMatches(row.identifier, e, null))) return row.identifier;
    if (phones.some((p) => identifierMatches(row.identifier, null, p))) return row.identifier;
  }
  return null;
}

/** Pending, unexpired instance invitation for `email` (lowercased comparison). */
export async function pendingInvitationFor(ctx: AppContext, email: string): Promise<typeof s.invitations.$inferSelect | undefined> {
  const normalized = normalizeEmail(email);
  return (await ctx.db
      .select()
      .from(s.invitations)
      .where(and(eq(s.invitations.email, normalized), eq(s.invitations.status, "pending"))))
    .find((row) => row.expiresAt === null || row.expiresAt > Date.now());
}

export function serializeInvitation(row: typeof s.invitations.$inferSelect): InvitationJSON {
  const expired = row.status === "pending" && row.expiresAt !== null && row.expiresAt <= Date.now();
  return {
    object: "invitation",
    id: row.id,
    email_address: row.email,
    status: expired ? "expired" : (row.status as InvitationJSON["status"]),
    public_metadata: row.publicMetadata ?? {},
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    expires_at: row.expiresAt,
  };
}

/** Validates a one-time ticket without consuming it (used while screening sign-ups). */
export async function validateTicket(ctx: AppContext, ticket: string): Promise<TicketGrant> {
  const tokenHash = sha256(ticket);
  const now = Date.now();

  const signInToken = first(await ctx.db.select().from(s.signInTokens).where(eq(s.signInTokens.tokenHash, tokenHash)));
  if (signInToken) {
    if (signInToken.status !== "pending") throw new OrbitError(422, ErrorCodes.ticket_invalid, "This sign-in ticket has already been used or revoked.");
    if (signInToken.expiresAt <= now) throw new OrbitError(422, ErrorCodes.ticket_expired, "This sign-in ticket has expired.");
    return { kind: "sign_in_token", userId: signInToken.userId };
  }

  const actorToken = first(await ctx.db.select().from(s.actorTokens).where(eq(s.actorTokens.tokenHash, tokenHash)));
  if (actorToken) {
    if (actorToken.status !== "pending") throw new OrbitError(422, ErrorCodes.ticket_invalid, "This actor ticket has already been used or revoked.");
    if (actorToken.expiresAt <= now) throw new OrbitError(422, ErrorCodes.ticket_expired, "This actor ticket has expired.");
    return {
      kind: "actor_token",
      userId: actorToken.userId,
      actor: (actorToken.actor ?? {}) as Record<string, unknown>,
      sessionMaxDurationSeconds: actorToken.sessionMaxDurationSeconds,
    };
  }

  const invitation = first(await ctx.db.select().from(s.invitations).where(eq(s.invitations.tokenHash, tokenHash)));
  if (invitation) {
    if (invitation.status !== "pending") throw new OrbitError(422, ErrorCodes.ticket_invalid, "This invitation has already been used or revoked.");
    if (invitation.expiresAt !== null && invitation.expiresAt <= now) throw new OrbitError(422, ErrorCodes.ticket_expired, "This invitation has expired.");
    return { kind: "invitation", invitationId: invitation.id, email: invitation.email, publicMetadata: invitation.publicMetadata ?? {} };
  }

  throw new OrbitError(422, ErrorCodes.ticket_invalid, "This ticket is invalid.");
}

/**
 * Throws OrbitError (sign_up_restricted / identifier_not_allowed_access / sign_up_restricted_waitlist) when sign-up
 * of these identifiers is not permitted. Also enforces the blocklist at sign-IN (pass `signIn: true`).
 */
export async function assertIdentifiersAllowed(
  ctx: AppContext,
  _ids: IdentifiersToCheck,
  _opts: { signIn?: boolean } = {},
): Promise<{ invitationId?: string }> {
  const settings = ctx.settings.get();
  const emails = (_ids.emails ?? []).map(normalizeEmail).filter(Boolean);
  const phones = (_ids.phones ?? []).map(normalizePhone).filter(Boolean);
  if (!emails.length && !phones.length) return {};

  // Blocked identifiers never get in — neither via sign-up nor (when the caller opts in) sign-in.
  const blocked = settings.restrictions.blocklistEnabled ? await blocklistMatches(ctx, emails, phones) : null;
  if (blocked) {
    throw new OrbitError(422, ErrorCodes.not_allowed_access, `Access denied for ${blocked}.`, { param_name: "identifier" });
  }
  if (settings.restrictions.blockEmailSubaddresses) {
    const bases = emails.filter((e) => e.includes("+")).map((e) => `${e.slice(0, e.indexOf("+"))}@${emailDomain(e)}`);
    if (bases.length && await blocklistMatches(ctx, bases, [])) {
      throw new OrbitError(422, ErrorCodes.not_allowed_access, "Access denied: this email address is blocked.", { param_name: "email_address" });
    }
  }
  if (settings.restrictions.blockDisposableEmailDomains && emails.some((e) => DISPOSABLE_EMAIL_DOMAINS[emailDomain(e)] === true)) {
    throw new OrbitError(422, ErrorCodes.not_allowed_access, "Disposable email addresses are not allowed.", { param_name: "email_address" });
  }

  if (_opts.signIn) return {};

  // A valid ticket proves the user was invited (or is being impersonated) and bypasses every sign-up restriction.
  if (_ids.invitationTicket) {
    const grant = await validateTicket(ctx, _ids.invitationTicket);
    return grant.kind === "invitation" ? { invitationId: grant.invitationId } : {};
  }

  const mode = settings.signUp.mode;
  if (mode === "public") return {};

  let invitation: Awaited<ReturnType<typeof pendingInvitationFor>>;
  for (const email of emails) {
    invitation = await pendingInvitationFor(ctx, email);
    if (invitation) break;
  }
  const allowlisted = settings.restrictions.allowlistEnabled && await allowlistMatches(ctx, emails, phones);

  if (mode === "restricted") {
    if (allowlisted || invitation) return { invitationId: invitation?.id };
    throw new OrbitError(422, ErrorCodes.sign_up_restricted, "Sign-ups are restricted to invited users on this application.");
  }

  const waitlistApproved = emails.length
    ? (await ctx.db
              .select()
              .from(s.waitlistEntries)
              .where(inArray(s.waitlistEntries.email, emails)))
        .some((row) => row.status === "invited" || row.status === "completed")
    : false;
  if (allowlisted || invitation || waitlistApproved) return { invitationId: invitation?.id };
  throw new OrbitError(422, ErrorCodes.waitlist_mode, "You need an invitation to sign up for this application.");
}

/** Validates + consumes sign_in_token / actor_token / app-invitation tickets (strategy "ticket"). Returns what the ticket grants. */
export async function redeemTicket(
  ctx: AppContext,
  _ticket: string,
): Promise<{ kind: "sign_in_token" | "actor_token"; userId: string; actor?: Record<string, unknown>; sessionMaxDurationSeconds?: number } | { kind: "invitation"; invitationId: string; email: string; publicMetadata: Record<string, unknown> }> {
  const tokenHash = sha256(_ticket);
  const now = Date.now();
  // Redeeming is the single statement that decides the winner; a loser gets the same errors as a reused ticket.
  const signInToken = first(await ctx.db.update(s.signInTokens).set({ status: "accepted" })
    .where(and(eq(s.signInTokens.tokenHash, tokenHash), eq(s.signInTokens.status, "pending"), gt(s.signInTokens.expiresAt, now)))
    .returning());
  if (signInToken) return { kind: "sign_in_token", userId: signInToken.userId };
  const actorToken = first(await ctx.db.update(s.actorTokens).set({ status: "accepted" })
    .where(and(eq(s.actorTokens.tokenHash, tokenHash), eq(s.actorTokens.status, "pending"), gt(s.actorTokens.expiresAt, now)))
    .returning());
  if (actorToken) {
    return {
      kind: "actor_token",
      userId: actorToken.userId,
      actor: (actorToken.actor ?? {}) as Record<string, unknown>,
      sessionMaxDurationSeconds: actorToken.sessionMaxDurationSeconds,
    };
  }
  // Only an invitation can still be live here; validateTicket raises the exact error otherwise.
  const grant = await validateTicket(ctx, _ticket);
  if (grant.kind !== "invitation") throw new OrbitError(422, ErrorCodes.ticket_invalid, "This ticket has already been used or revoked.");
  // Invitations stay `pending` until the sign-up completes (markInvitationAccepted).
  return { kind: "invitation", invitationId: grant.invitationId, email: grant.email, publicMetadata: grant.publicMetadata };
}

/** Mark an invitation accepted & waitlist entry completed after a successful sign-up. */
export async function markInvitationAccepted(ctx: AppContext, _invitationId: string, _userId: string): Promise<void> {
  const now = Date.now();
  const accepted = first(await ctx.db.update(s.invitations).set({ status: "accepted", updatedAt: now })
    .where(and(
      eq(s.invitations.id, _invitationId),
      eq(s.invitations.status, "pending"),
      or(isNull(s.invitations.expiresAt), gt(s.invitations.expiresAt, now)),
    ))
    .returning());
  if (!accepted) return;
  await ctx.db.update(s.waitlistEntries).set({ status: "completed", updatedAt: now }).where(eq(s.waitlistEntries.invitationId, accepted.id));
  await emitEvent(ctx, "invitation.accepted", { ...serializeInvitation(accepted), status: "accepted", user_id: _userId, updated_at: now });
}
