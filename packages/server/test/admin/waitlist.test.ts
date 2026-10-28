import { describe, it, expect, vi } from "vitest";
import { ID_PREFIX, type PaginatedList, type WaitlistEntryJSON } from "@orbitid/shared";
import { markInvitationAccepted, redeemTicket } from "../../src/services/restrictions";
import { createUser, json, testApp, ticketFromUrl, type ErrorBody } from "./helpers";

type SendEmail = (ctx: unknown, input: { to: string; template: string; vars: Record<string, string> }) => Promise<void>;
const { sendEmail } = vi.hoisted(() => ({ sendEmail: vi.fn<SendEmail>(async () => undefined) }));
vi.mock("../../src/services/mail", () => ({ sendEmail, sendSms: vi.fn(async () => undefined) }));

describe("waitlist", () => {
  it("is closed unless the instance is in waitlist mode", async () => {
    const { fapi, api } = await testApp();
    const rejected = await fapi("POST", "/v1/client/waitlist", { email_address: "early@example.com" });
    expect(rejected.status).toBe(422);
    expect((await json<ErrorBody>(rejected)).errors[0]!.code).toBe("sign_up_mode_restricted");
    expect((await json<PaginatedList<WaitlistEntryJSON>>(await api("GET", "/v1/waitlist_entries"))).total_count).toBe(0);
  });

  it("collects public sign-ups once and lists them for admins", async () => {
    const { ctx, api, fapi } = await testApp();
    await ctx.settings.update({ signUp: { mode: "waitlist" } });

    const created = await json<{ response: WaitlistEntryJSON }>(await fapi("POST", "/v1/client/waitlist", { email_address: "Early@Example.com" }));
    expect(created.response.object).toBe("waitlist_entry");
    expect(created.response.email_address).toBe("early@example.com");
    expect(created.response.status).toBe("pending");

    const duplicate = await json<{ response: WaitlistEntryJSON }>(await fapi("POST", "/v1/client/waitlist", { email_address: "early@example.com" }));
    expect(duplicate.response.id).toBe(created.response.id);
    expect((await json<PaginatedList<WaitlistEntryJSON>>(await api("GET", "/v1/waitlist_entries"))).total_count).toBe(1);

    expect((await fapi("POST", "/v1/client/waitlist", { email_address: "not-an-email" })).status).toBe(422);
  });

  it("lets admins add, filter, invite and reject entries", async () => {
    const { api } = await testApp();
    const first = await json<WaitlistEntryJSON>(await api("POST", "/v1/waitlist_entries", { email_address: "one@example.com" }));
    await json<WaitlistEntryJSON>(await api("POST", "/v1/waitlist_entries", { email_address: "two@example.com" }));
    expect((await api("POST", "/v1/waitlist_entries", { email_address: "one@example.com" })).status).toBe(422);

    const list = await json<PaginatedList<WaitlistEntryJSON>>(await api("GET", "/v1/waitlist_entries?status=pending&query=one@"));
    expect(list.data.map((entry) => entry.email_address)).toEqual(["one@example.com"]);

    const invited = await json<WaitlistEntryJSON>(await api("POST", `/v1/waitlist_entries/${first.id}/invite`));
    expect(invited.status).toBe("invited");
    expect(invited.invitation?.email_address).toBe("one@example.com");
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0]![1].template).toBe("waitlist_invited");
    expect((await json<PaginatedList<WaitlistEntryJSON>>(await api("GET", "/v1/waitlist_entries?status=invited"))).total_count).toBe(1);

    const rejected = await json<WaitlistEntryJSON>(await api("POST", `/v1/waitlist_entries/${invited.id}/reject`));
    expect(rejected.status).toBe("rejected");

    expect(await json(await api("DELETE", `/v1/waitlist_entries/${rejected.id}`))).toEqual({ object: "waitlist_entry", id: rejected.id, deleted: true });
    expect((await api("POST", `/v1/waitlist_entries/${rejected.id}/invite`)).status).toBe(404);
  });

  it("completes the entry once the invited user signs up", async () => {
    const { ctx, api, fapi } = await testApp();
    await ctx.settings.update({ signUp: { mode: "waitlist" } });
    const entry = await json<{ response: WaitlistEntryJSON }>(await fapi("POST", "/v1/client/waitlist", { email_address: "approved@example.com" }));
    const invited = await json<WaitlistEntryJSON>(await api("POST", `/v1/waitlist_entries/${entry.response.id}/invite`));
    const ticket = ticketFromUrl(invited.invitation!.url ?? "");
    await expect(redeemTicket(ctx, ticket)).resolves.toMatchObject({ kind: "invitation", email: "approved@example.com" });

    const user = await createUser(api, { email_address: ["approved@example.com"] });
    await markInvitationAccepted(ctx, invited.invitation!.id, user.id);
    expect((await json<PaginatedList<WaitlistEntryJSON>>(await api("GET", "/v1/waitlist_entries?status=completed"))).data[0]!.id).toBe(entry.response.id);
    expect((await api("POST", `/v1/waitlist_entries/${entry.response.id}/invite`)).status).toBe(422);
  });
});
