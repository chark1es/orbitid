import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { resetVirtualRouter } from "../../../lib/routing";
import { OrganizationProfile } from "../OrganizationProfile";
import { createFakeInstance, renderWithOrbit } from "./harness";

beforeEach(() => {
  resetVirtualRouter();
});

describe("<OrganizationProfile /> danger zone", () => {
  test("leaves the organization and redirects", async () => {
    const fake = createFakeInstance();
    const orgId = fake.backend.orgs[0]!.id;
    renderWithOrbit(
      <OrganizationProfile routing="virtual" afterLeaveOrganizationUrl="/after-leave" />,
      fake,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Leave organization" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Leave organization" }));

    await waitFor(() => expect(fake.backend.calls.leftOrganizations).toEqual([orgId]));
    await waitFor(() => expect(fake.backend.calls.setActive).toEqual([null]));
    expect(fake.backend.calls.navigate).toEqual(["/after-leave"]);
  });

  test("shows the last-admin error when leaving is rejected", async () => {
    const fake = createFakeInstance();
    fake.backend.failMutation = {
      leaveOrganization: {
        errors: [
          {
            code: "organization_minimum_permissions_needed",
            message: "You must be an admin",
          },
        ],
      },
    };
    renderWithOrbit(<OrganizationProfile routing="virtual" />, fake);

    fireEvent.click(await screen.findByRole("button", { name: "Leave organization" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Leave organization" }));

    expect(
      await within(dialog).findByText("You must be an admin to perform this action."),
    ).toBeTruthy();
    expect(fake.backend.calls.setActive).toHaveLength(0);
  });

  test("deletes the organization only after typing its name", async () => {
    const fake = createFakeInstance();
    const orgId = fake.backend.orgs[0]!.id;
    renderWithOrbit(<OrganizationProfile routing="virtual" />, fake);

    fireEvent.click(await screen.findByRole("button", { name: "Delete organization" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Delete organization" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(within(dialog).getByLabelText("Organization name"), {
      target: { value: "Acme" },
    });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() => expect(fake.backend.calls.destroyedOrganizations).toEqual([orgId]));
    expect(fake.backend.orgs).toHaveLength(0);
    expect(fake.backend.calls.navigate).toEqual(["/"]);
  });

  test("hides organization deletion when the instance disables it", async () => {
    const fake = createFakeInstance({ orgDefaults: { adminDeleteEnabled: false } });
    renderWithOrbit(<OrganizationProfile routing="virtual" />, fake);

    expect(await screen.findByText(/Organization deletion is disabled/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete organization" })).toBeNull();
  });
});
