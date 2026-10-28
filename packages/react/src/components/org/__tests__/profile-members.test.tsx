import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { resetVirtualRouter } from "../../../lib/routing";
import { OrganizationProfile } from "../OrganizationProfile";
import { createFakeInstance, renderWithOrbit } from "./harness";

beforeEach(() => {
  resetVirtualRouter();
});

async function openMembers(fake: ReturnType<typeof createFakeInstance>) {
  renderWithOrbit(<OrganizationProfile routing="virtual" />, fake);
  fireEvent.click(await screen.findByRole("button", { name: "Members" }));
  const orgId = fake.backend.orgs[0]!.id;
  return { orgId, rowTestId: `member-row-mem_${orgId}_user_member` };
}

describe("<OrganizationProfile /> members", () => {
  test("invites multiple members with a role and refreshes the invitation list", async () => {
    const fake = createFakeInstance();
    await openMembers(fake);

    fireEvent.click(await screen.findByRole("button", { name: "Invite" }));
    const dialog = await screen.findByRole("dialog");

    const emailInput = within(dialog).getByLabelText("Email addresses");
    fireEvent.change(emailInput, { target: { value: "new1@example.com" } });
    fireEvent.keyDown(emailInput, { key: "Enter" });
    fireEvent.change(emailInput, { target: { value: "new2@example.com" } });
    fireEvent.keyDown(emailInput, { key: "Enter" });

    expect(within(dialog).getByText("new1@example.com")).toBeTruthy();
    expect(within(dialog).getByText("new2@example.com")).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Invite" }));

    await waitFor(() =>
      expect(fake.backend.calls.invites).toEqual([
        { emailAddresses: ["new1@example.com", "new2@example.com"], role: "org:member" },
      ]),
    );
    expect(fake.backend.invitations[fake.backend.orgs[0]!.id]).toHaveLength(2);
  });

  test("rejects invalid email addresses before submitting", async () => {
    const fake = createFakeInstance();
    await openMembers(fake);

    fireEvent.click(await screen.findByRole("button", { name: "Invite" }));
    const dialog = await screen.findByRole("dialog");
    const emailInput = within(dialog).getByLabelText("Email addresses");
    fireEvent.change(emailInput, { target: { value: "not-an-email" } });
    fireEvent.keyDown(emailInput, { key: "Enter" });

    expect(await within(dialog).findByText("Enter a valid email address.")).toBeTruthy();
    expect(fake.backend.calls.invites).toHaveLength(0);
  });

  test("changes a member's role through the membership resource", async () => {
    const fake = createFakeInstance();
    const { rowTestId } = await openMembers(fake);

    const row = await screen.findByTestId(rowTestId);
    fireEvent.click(within(row).getByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: "Admin" }));

    await waitFor(() =>
      expect(fake.backend.calls.roleUpdates).toEqual([{ userId: "user_member", role: "org:admin" }]),
    );
    const member = fake.backend.members[fake.backend.orgs[0]!.id]!.find(
      (candidate) => candidate.userId === "user_member",
    );
    expect(member?.role).toBe("org:admin");
  });

  test("surfaces the last-admin error when the server rejects a role change", async () => {
    const fake = createFakeInstance();
    fake.backend.failMutation = {
      updateRole: {
        errors: [
          {
            code: "organization_minimum_permissions_needed",
            message: "There must be at least one admin",
          },
        ],
      },
    };
    const { rowTestId } = await openMembers(fake);

    const row = await screen.findByTestId(rowTestId);
    fireEvent.click(within(row).getByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: "Admin" }));

    expect(
      await screen.findByText(
        "The organization needs at least one admin. Promote another member before changing this role.",
      ),
    ).toBeTruthy();
    expect(fake.backend.calls.roleUpdates).toHaveLength(0);
  });

  test("removes a member after confirmation", async () => {
    const fake = createFakeInstance();
    const { rowTestId } = await openMembers(fake);

    await screen.findByTestId(rowTestId);
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove member Grace Hopper" }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove member" }));

    await waitFor(() => expect(fake.backend.calls.memberRemovals).toEqual(["user_member"]));
    await waitFor(() => expect(screen.queryByTestId(rowTestId)).toBeNull());
  });
});
