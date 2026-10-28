import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { resetVirtualRouter } from "../../../lib/routing";
import { OrganizationProfile } from "../OrganizationProfile";
import { createFakeInstance, renderWithOrbit } from "./harness";

beforeEach(() => resetVirtualRouter());

function seedRequest(fake: ReturnType<typeof createFakeInstance>) {
  const orgId = fake.backend.orgs[0]!.id;
  fake.backend.membershipRequests[orgId] = [
    {
      userId: "user_req",
      firstName: "Alan",
      lastName: "Turing",
      identifier: "alan@example.com",
      role: "org:member",
    },
  ];
  return orgId;
}

describe("<OrganizationProfile /> membership requests", () => {
  test("accepts a request and adds the member", async () => {
    const fake = createFakeInstance({
      organizationSettings: { membershipRequestsEnabled: true },
    });
    const orgId = seedRequest(fake);
    renderWithOrbit(<OrganizationProfile routing="virtual" />, fake);

    fireEvent.click(await screen.findByRole("button", { name: "Members" }));
    fireEvent.mouseDown(await screen.findByRole("tab", { name: "Membership requests" }));
    expect(await screen.findByText("Alan Turing")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Accept" }));

    await waitFor(() =>
      expect(
        fake.backend.members[orgId]!.some((member) => member.userId === "user_req"),
      ).toBe(true),
    );
    expect(fake.backend.membershipRequests[orgId]).toHaveLength(0);
  });

  test("rejects a request without adding the member", async () => {
    const fake = createFakeInstance({
      organizationSettings: { membershipRequestsEnabled: true },
    });
    const orgId = seedRequest(fake);
    renderWithOrbit(<OrganizationProfile routing="virtual" />, fake);

    fireEvent.click(await screen.findByRole("button", { name: "Members" }));
    fireEvent.mouseDown(await screen.findByRole("tab", { name: "Membership requests" }));
    await screen.findByText("Alan Turing");

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));

    await waitFor(() => expect(fake.backend.membershipRequests[orgId]).toHaveLength(0));
    expect(
      fake.backend.members[orgId]!.some((member) => member.userId === "user_req"),
    ).toBe(false);
  });

  test("hides the requests tab when membership requests are disabled", async () => {
    const fake = createFakeInstance();
    renderWithOrbit(<OrganizationProfile routing="virtual" />, fake);

    fireEvent.click(await screen.findByRole("button", { name: "Members" }));
    await screen.findByLabelText("Search members");
    expect(screen.queryByRole("tab", { name: "Membership requests" })).toBeNull();
  });
});
