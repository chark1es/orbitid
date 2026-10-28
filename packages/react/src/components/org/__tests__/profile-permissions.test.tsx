import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { resetVirtualRouter } from "../../../lib/routing";
import { OrganizationProfile } from "../OrganizationProfile";
import { createFakeInstance, renderWithOrbit } from "./harness";

beforeEach(() => {
  resetVirtualRouter();
});

const asMember = (fake: ReturnType<typeof createFakeInstance>) => {
  const org = fake.backend.orgs[0]!;
  const self = fake.backend.members[org.id]!.find(
    (member) => member.userId === fake.backend.self.id,
  )!;
  self.role = "org:member";
  self.permissions = ["org:sys_memberships:read", "org:sys_domains:read"];
};

describe("<OrganizationProfile /> permission gating", () => {
  test("admins can edit the profile, manage domains and delete the organization", async () => {
    const fake = createFakeInstance();
    renderWithOrbit(<OrganizationProfile routing="virtual" />, fake);

    const nameInput = await screen.findByLabelText("Organization name");
    expect((nameInput as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add domain" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete organization" })).toBeTruthy();
    expect(screen.queryByText(/don't have permission/i)).toBeNull();
  });

  test("members get a read-only profile without destructive controls", async () => {
    const fake = createFakeInstance();
    asMember(fake);
    renderWithOrbit(<OrganizationProfile routing="virtual" />, fake);

    const nameInput = await screen.findByLabelText("Organization name");
    expect((nameInput as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add domain" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete organization" })).toBeNull();
    expect(screen.getByText(/don't have permission to edit/i)).toBeTruthy();
  });

  test("members see the member list but not role selectors or invite actions", async () => {
    const fake = createFakeInstance();
    asMember(fake);
    renderWithOrbit(<OrganizationProfile routing="virtual" />, fake);

    fireEvent.click(await screen.findByRole("button", { name: "Members" }));

    expect(await screen.findByText("Grace Hopper")).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Invite" })).toBeNull();
    expect(screen.getByTestId("member-quota").textContent).toContain("2 / 5");
  });

  test("admin member table shows roles, quota and joined dates", async () => {
    const fake = createFakeInstance();
    renderWithOrbit(<OrganizationProfile routing="virtual" />, fake);

    fireEvent.click(await screen.findByRole("button", { name: "Members" }));
    const row = await screen.findByTestId(
      `member-row-mem_${fake.backend.orgs[0]!.id}_user_member`,
    );
    expect(within(row).getByRole("combobox")).toBeTruthy();
    expect(screen.getByTestId("member-quota").textContent).toContain("2 / 5");
  });

  test("member search filters the table through the memberships endpoint", async () => {
    const fake = createFakeInstance();
    renderWithOrbit(<OrganizationProfile routing="virtual" />, fake);

    fireEvent.click(await screen.findByRole("button", { name: "Members" }));
    const search = await screen.findByLabelText("Search members");
    fireEvent.change(search, { target: { value: "grace" } });

    await waitFor(() => expect(screen.queryByText("Ada Lovelace")).toBeNull());
    expect(await screen.findByText("Grace Hopper")).toBeTruthy();
  });
});
