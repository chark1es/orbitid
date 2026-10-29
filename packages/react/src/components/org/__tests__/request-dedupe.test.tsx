import { beforeEach, describe, expect, test, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { resetVirtualRouter } from "../../../lib/routing";
import { UserButton } from "../../auth/user-button";
import { UserProfile } from "../../auth/user-profile";
import { OrganizationList } from "../OrganizationList";
import { OrganizationSwitcher } from "../OrganizationSwitcher";
import { createFakeInstance, renderWithOrbit } from "./harness";

beforeEach(() => {
  resetVirtualRouter();
});

describe("user organization data", () => {
  test("three components mounted together issue each GET once", async () => {
    const fake = createFakeInstance();
    const user = fake.instance.user!;
    const memberships = vi.fn(user.getOrganizationMemberships.bind(user));
    const invitations = vi.fn(user.getOrganizationInvitations.bind(user));
    const suggestions = vi.fn(user.getOrganizationSuggestions.bind(user));
    user.getOrganizationMemberships = memberships;
    user.getOrganizationInvitations = invitations;
    user.getOrganizationSuggestions = suggestions;

    renderWithOrbit(
      <>
        <UserButton />
        <OrganizationSwitcher />
        <OrganizationList />
        <UserProfile />
      </>,
      fake,
    );

    await waitFor(() => expect(memberships).toHaveBeenCalled());
    await waitFor(() => expect(invitations).toHaveBeenCalled());
    await waitFor(() => expect(suggestions).toHaveBeenCalled());

    expect(memberships).toHaveBeenCalledTimes(1);
    expect(invitations).toHaveBeenCalledTimes(1);
    expect(suggestions).toHaveBeenCalledTimes(1);
  });
});
