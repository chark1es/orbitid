import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { ErrorCodes, type InvitationJSON, type PaginatedList } from "@orbitid/shared";
import * as s from "../../src/db/schema";
import { markInvitationAccepted, redeemTicket } from "../../src/services/restrictions";
import { createUser, json, testApp, ticketFromUrl, type ErrorBody } from "./helpers";

type SendEmail = (ctx: unknown, input: { to: string; template: string; vars: Record<string, string> }) => Promise<void>;
const { sendEmail } = vi.hoisted(() => ({ sendEmail: vi.fn<SendEmail>(async () => undefined) }));
vi.mock("../../src/services/mail", () => ({ sendEmail, sendSms: vi.fn(async () => undefined) }));

beforeEach(() => {
  sendEmail.mockClear();
  sendEmail.mockResolvedValue(undefined);
});

describe("instance invitations", () => {
  it("creates an invitation with a ticket URL and notifies the invitee", async () => {
    const { api } = await testApp();
    const res = await api("POST", "/v1/invitations", { email_address: "Invitee@Example.com", public_metadata: { team: "core" }, redirect_url: "https://app.example.com/welcome" });
    expect(res.status).toBe(200);
    const invitation = await json<InvitationJSON>(res);
    expect(invitation.email_address).toBe("invitee@example.com");
    expect(invitation.status).toBe("pending");
    expect(invitation.public_metadata).toEqual({ team: "core" });
    expect(invitation.expires_at!).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    expect(invitation.url).toContain("/sign-up?__orbit_ticket=");
    expect(ticketFromUrl(invitation.url!)).toBeTruthy();

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const mail = sendEmail.mock.calls[0]![1];
    expect(mail.to).toBe("invitee@example.com");
    expect(mail.template).toBe("invitation");
    expect(mail.vars.invitation_url).toContain("__orbit_ticket=");
  });

  it("refuses duplicates unless ignore_existing is set, and survives mail failures", async () => {
    const { api } = await testApp();
    expect((await api("POST", "/v1/invitations", { email_address: "dup@example.com", notify: false })).status).toBe(200);

    const duplicate = await api("POST", "/v1/invitations", { email_address: "dup@example.com" });
    expect(duplicate.status).toBe(422);
    expect((await json<ErrorBody>(duplicate)).errors[0]!.code).toBe("duplicate_record");
    expect((await api("POST", "/v1/invitations", { email_address: "dup@example.com", ignore_existing: true })).status).toBe(200);

    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    sendEmail.mockRejectedValueOnce(new Error("smtp down"));
    const stillCreated = await api("POST", "/v1/invitations", { email_address: "smtp@example.com" });
    quiet.mockRestore();
    expect(stillCreated.status).toBe(200);
    expect((await json<InvitationJSON>(stillCreated)).status).toBe("pending");
  });

  it("redeems the invitation ticket once and marks the invitation accepted on sign-up", async () => {
    const { api, ctx } = await testApp();
    const invitation = await json<InvitationJSON>(
      await api("POST", "/v1/invitations", { email_address: "redeem@example.com", public_metadata: { ref: "abc" }, notify: false }),
    );
    const ticket = ticketFromUrl(invitation.url!);

    await expect(redeemTicket(ctx, ticket)).resolves.toEqual({
      kind: "invitation",
      invitationId: invitation.id,
      email: "redeem@example.com",
      publicMetadata: { ref: "abc" },
    });
    // Redeeming starts the sign-up; the invitation stays pending until the account exists.
    expect((await json<InvitationJSON>(await api("GET", `/v1/invitations/${invitation.id}`))).status).toBe("pending");

    const user = await createUser(api, { email_address: ["redeem@example.com"] });
    await markInvitationAccepted(ctx, invitation.id, user.id);
    expect((await json<InvitationJSON>(await api("GET", `/v1/invitations/${invitation.id}`))).status).toBe("accepted");
    await expect(redeemTicket(ctx, ticket)).rejects.toMatchObject({ code: ErrorCodes.ticket_invalid });
  });

  it("bulk creates, lists by status and revokes", async () => {
    const { api } = await testApp();
    const bulk = await json<InvitationJSON[]>(await api("POST", "/v1/invitations/bulk", { email_addresses: ["one@example.com", "two@example.com"], notify: false }));
    expect(bulk.map((i) => i.email_address).sort()).toEqual(["one@example.com", "two@example.com"]);
    expect(await json<InvitationJSON[]>(await api("POST", "/v1/invitations/bulk", { email_addresses: ["one@example.com"], notify: false }))).toEqual([]);

    const pending = await json<PaginatedList<InvitationJSON>>(await api("GET", "/v1/invitations?status=pending"));
    expect(pending.total_count).toBe(2);
    expect((await json<PaginatedList<InvitationJSON>>(await api("GET", "/v1/invitations?query=one@"))).data.map((i) => i.email_address)).toEqual(["one@example.com"]);

    const revoked = await json<InvitationJSON>(await api("POST", `/v1/invitations/${bulk[0]!.id}/revoke`));
    expect(revoked.status).toBe("revoked");
    expect((await json<PaginatedList<InvitationJSON>>(await api("GET", "/v1/invitations?status=revoked"))).total_count).toBe(1);
    expect((await api("POST", "/v1/invitations/inv_nope/revoke")).status).toBe(404);
  });

  it("reports expired invitations and refuses their tickets", async () => {
    const { api, ctx } = await testApp();
    const invitation = await json<InvitationJSON>(await api("POST", "/v1/invitations", { email_address: "stale@example.com", notify: false }));
    ctx.db.update(s.invitations).set({ expiresAt: Date.now() - 1 }).where(eq(s.invitations.id, invitation.id)).run();

    expect((await json<InvitationJSON>(await api("GET", `/v1/invitations/${invitation.id}`))).status).toBe("expired");
    await expect(redeemTicket(ctx, ticketFromUrl(invitation.url!))).rejects.toMatchObject({ code: ErrorCodes.ticket_expired });
  });
});
