import { describe, it, expect, vi } from "vitest";
import { ErrorCodes, ID_PREFIX, type AllowlistIdentifierJSON, type BlocklistIdentifierJSON, type InvitationJSON, type PaginatedList } from "@orbitid/shared";
import * as s from "../../src/db/schema";
import { newId } from "../../src/lib/ids";
import { assertIdentifiersAllowed } from "../../src/services/restrictions";
import { json, testApp, ticketFromUrl } from "./helpers";

const { sendEmail } = vi.hoisted(() => ({ sendEmail: vi.fn(async () => undefined) }));
vi.mock("../../src/services/mail", () => ({ sendEmail, sendSms: vi.fn(async () => undefined) }));

describe("sign-up restrictions", () => {
  it("allows every identifier in public mode", async () => {
    const { ctx } = await testApp();
    await expect(assertIdentifiersAllowed(ctx, { emails: ["anyone@example.com"] })).resolves.toEqual({});
    await expect(assertIdentifiersAllowed(ctx, { emails: ["anyone@example.com"], phones: ["+15551234567"] }, { signIn: true })).resolves.toEqual({});
  });

  it("restricted mode requires an allowlist match", async () => {
    const { api, ctx } = await testApp();
    await ctx.settings.update({ signUp: { mode: "restricted" } });

    await expect(assertIdentifiersAllowed(ctx, { emails: ["blocked@example.com"] })).rejects.toMatchObject({ code: ErrorCodes.sign_up_restricted });

    await api("POST", "/v1/allowlist_identifiers", { identifier: "allowed@example.com" });
    await expect(assertIdentifiersAllowed(ctx, { emails: ["allowed@example.com"] })).resolves.toEqual({});
    // Whole-domain allowlist entries match every address on the domain.
    await api("POST", "/v1/allowlist_identifiers", { identifier: "*@partner.example" });
    await expect(assertIdentifiersAllowed(ctx, { emails: ["dev@partner.example"] })).resolves.toEqual({});
    await expect(assertIdentifiersAllowed(ctx, { emails: ["dev@other.example"] })).rejects.toMatchObject({ code: ErrorCodes.sign_up_restricted });

    await api("POST", "/v1/allowlist_identifiers", { identifier: "+15551239999" });
    await expect(assertIdentifiersAllowed(ctx, { phones: ["+15551239999"] })).resolves.toEqual({});
  });

  it("blocks blocklisted identifiers on sign-up and sign-in", async () => {
    const { api, ctx } = await testApp();
    const res = await api("POST", "/v1/blocklist_identifiers", { identifier: "Bad@Example.com" });
    expect((await json<BlocklistIdentifierJSON>(res)).identifier).toBe("bad@example.com");
    expect(ctx.settings.get().restrictions.blocklistEnabled).toBe(true);

    await expect(assertIdentifiersAllowed(ctx, { emails: ["bad@example.com"] })).rejects.toMatchObject({ code: ErrorCodes.not_allowed_access });
    await expect(assertIdentifiersAllowed(ctx, { emails: ["bad@example.com"] }, { signIn: true })).rejects.toMatchObject({ code: ErrorCodes.not_allowed_access });
    await expect(assertIdentifiersAllowed(ctx, { emails: ["fine@example.com"] }, { signIn: true })).resolves.toEqual({});

    await api("POST", "/v1/blocklist_identifiers", { identifier: "@spam.example" });
    await expect(assertIdentifiersAllowed(ctx, { emails: ["user@spam.example"] })).rejects.toMatchObject({ code: ErrorCodes.not_allowed_access });

    // Disabling the feature re-enables those identifiers.
    await ctx.settings.update({ restrictions: { blocklistEnabled: false } });
    await expect(assertIdentifiersAllowed(ctx, { emails: ["bad@example.com"] })).resolves.toEqual({});
  });

  it("blocks subaddresses and disposable domains when enabled", async () => {
    const { api, ctx } = await testApp();
    await api("POST", "/v1/blocklist_identifiers", { identifier: "tagged@example.com" });
    await expect(assertIdentifiersAllowed(ctx, { emails: ["tagged+promo@example.com"] })).resolves.toEqual({});

    await ctx.settings.update({ restrictions: { blockEmailSubaddresses: true } });
    await expect(assertIdentifiersAllowed(ctx, { emails: ["tagged+promo@example.com"] })).rejects.toMatchObject({ code: ErrorCodes.not_allowed_access });
    await expect(assertIdentifiersAllowed(ctx, { emails: ["other+promo@example.com"] })).resolves.toEqual({});

    await ctx.settings.update({ restrictions: { blockDisposableEmailDomains: true } });
    await expect(assertIdentifiersAllowed(ctx, { emails: ["throwaway@mailinator.com"] })).rejects.toMatchObject({ code: ErrorCodes.not_allowed_access });
    await expect(assertIdentifiersAllowed(ctx, { emails: ["real@example.com"] })).resolves.toEqual({});
  });

  it("waitlist mode requires an approved entry or an invitation", async () => {
    const { api, ctx } = await testApp();
    await ctx.settings.update({ signUp: { mode: "waitlist" } });
    const rejection = await assertIdentifiersAllowed(ctx, { emails: ["waiting@example.com"] }).catch((err: unknown) => err);
    expect(rejection).toMatchObject({ code: ErrorCodes.waitlist_mode, status: 422 });

    await ctx.db.insert(s.waitlistEntries).values({ id: newId(ID_PREFIX.waitlist), email: "pending@example.com", status: "pending" });
    await expect(assertIdentifiersAllowed(ctx, { emails: ["pending@example.com"] })).rejects.toMatchObject({ code: ErrorCodes.waitlist_mode });

    await ctx.db.insert(s.waitlistEntries).values({ id: newId(ID_PREFIX.waitlist), email: "invited@example.com", status: "invited" });
    await expect(assertIdentifiersAllowed(ctx, { emails: ["invited@example.com"] })).resolves.toEqual({});

    const invitation = await json<InvitationJSON>(await api("POST", "/v1/invitations", { email_address: "invited-by-admin@example.com", notify: false }));
    await expect(assertIdentifiersAllowed(ctx, { emails: ["invited-by-admin@example.com"] })).resolves.toEqual({ invitationId: invitation.id });
  });

  it("lets a valid invitation ticket bypass restricted mode", async () => {
    const { api, ctx } = await testApp();
    await ctx.settings.update({ signUp: { mode: "restricted" } });
    const invitation = await json<InvitationJSON>(await api("POST", "/v1/invitations", { email_address: "ticket@example.com", public_metadata: { plan: "x" }, notify: false }));
    const ticket = ticketFromUrl(invitation.url!);

    await expect(assertIdentifiersAllowed(ctx, { emails: ["ticket@example.com"], invitationTicket: ticket })).resolves.toEqual({ invitationId: invitation.id });
    // The ticket is validated, not consumed, while screening the sign-up.
    expect((await ctx.db.select().from(s.invitations))[0]!.status).toBe("pending");
    await expect(assertIdentifiersAllowed(ctx, { emails: ["ticket@example.com"], invitationTicket: "bogus" })).rejects.toMatchObject({ code: ErrorCodes.ticket_invalid });
  });

  it("manages allowlist and blocklist identifiers over the API", async () => {
    const { api, ctx } = await testApp();
    const emailEntry = await json<AllowlistIdentifierJSON>(await api("POST", "/v1/allowlist_identifiers", { identifier: "vip@example.com", notify: true }));
    expect(emailEntry.identifier_type).toBe("email_address");
    expect(emailEntry.invitation_id).toEqual(expect.any(String));
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(ctx.settings.get().restrictions.allowlistEnabled).toBe(true);

    expect((await json<AllowlistIdentifierJSON>(await api("POST", "/v1/allowlist_identifiers", { identifier: "+15551230000" }))).identifier_type).toBe("phone_number");
    expect((await api("POST", "/v1/allowlist_identifiers", { identifier: "vip@example.com" })).status).toBe(422);
    expect((await json<PaginatedList<AllowlistIdentifierJSON>>(await api("GET", "/v1/allowlist_identifiers"))).total_count).toBe(2);
    expect(await json(await api("DELETE", `/v1/allowlist_identifiers/${emailEntry.id}`))).toEqual({ object: "allowlist_identifier", id: emailEntry.id, deleted: true });

    const blockEntry = await json<BlocklistIdentifierJSON>(await api("POST", "/v1/blocklist_identifiers", { identifier: "0xdeadbeef" }));
    expect(blockEntry.identifier_type).toBe("web3_wallet");
    expect((await json<PaginatedList<BlocklistIdentifierJSON>>(await api("GET", "/v1/blocklist_identifiers"))).total_count).toBe(1);
    expect(await json(await api("DELETE", `/v1/blocklist_identifiers/${blockEntry.id}`))).toEqual({ object: "blocklist_identifier", id: blockEntry.id, deleted: true });
    expect((await api("DELETE", "/v1/blocklist_identifiers/blid_nope")).status).toBe(404);
  });
});
