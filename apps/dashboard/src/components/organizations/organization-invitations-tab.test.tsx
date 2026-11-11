import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { OrganizationInvitationJSON, OrganizationJSON } from "@orbitid/shared";
import { OrganizationInvitationsTab } from "./organization-invitations-tab";
import { mockApi, renderPage, type ApiCall } from "../../pages/_config/__tests__/harness";

const ORG = { id: "org_1", name: "Acme", slug: "acme" } as OrganizationJSON;

const INVITATION = {
  id: "inv_1",
  email_address: "new@example.com",
  organization_id: "org_1",
  role: "org:member",
  role_name: "Member",
  status: "pending",
  public_metadata: {},
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
} as unknown as OrganizationInvitationJSON;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const list = (data: unknown[], total = data.length) => json({ data, total_count: total });

function renderTab(rows: unknown[] = [INVITATION], custom?: (call: ApiCall) => Response | undefined) {
  const calls = mockApi({
    handle: (call) => {
      const handled = custom?.(call);
      if (handled) return handled;
      if (call.method === "GET" && call.url.includes("/v1/organizations/org_1/invitations")) return list(rows);
      return undefined;
    },
  });
  const onChanged = vi.fn();
  renderPage(<OrganizationInvitationsTab org={ORG} onChanged={onChanged} />);
  return { calls, onChanged };
}

describe("organization invitations tab", () => {
  it("renders invitations with status", async () => {
    renderTab();
    expect(await screen.findByText("new@example.com")).toBeTruthy();
    expect(screen.getByText("Pending")).toBeTruthy();
    expect(screen.getByText("Member")).toBeTruthy();
  });

  it("shows the empty state", async () => {
    renderTab([]);
    expect(await screen.findByText("No invitations yet")).toBeTruthy();
  });

  it("invites an email address and shows the invitation link", async () => {
    const { calls, onChanged } = renderTab([], (call) =>
      call.method === "POST" && call.url.endsWith("/v1/organizations/org_1/invitations")
        ? json({ ...INVITATION, url: "https://app.test/invite/ticket" })
        : undefined,
    );
    await screen.findByText("No invitations yet");

    fireEvent.click(screen.getAllByRole("button", { name: /Invite/ })[0]!);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Email address"), { target: { value: "new@example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send invitation" }));

    await waitFor(() => {
      expect(calls.find((call) => call.method === "POST" && call.url.endsWith("/v1/organizations/org_1/invitations"))?.body).toEqual({
        email_address: "new@example.com",
        role: "org:member",
        notify: true,
      });
    });
    expect(await screen.findByText("Invitation link")).toBeTruthy();
    expect(onChanged).toHaveBeenCalled();
  });

  it("revokes a pending invitation only after confirmation", async () => {
    const { calls, onChanged } = renderTab();
    await screen.findByText("new@example.com");

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(screen.getByText("Revoke invitation?")).toBeTruthy();
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Revoke" }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/v1/organizations/org_1/invitations/inv_1/revoke"))).toBe(true);
    });
    expect(onChanged).toHaveBeenCalled();
  });

  it("filters by status through the request", async () => {
    const { calls } = renderTab();
    await screen.findByText("new@example.com");

    const trigger = screen.getByRole("combobox", { name: "Filter invitations by status" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "accepted" }));

    await waitFor(() => {
      expect(calls.some((call) => call.url.includes("status=accepted"))).toBe(true);
    });
  });
});
