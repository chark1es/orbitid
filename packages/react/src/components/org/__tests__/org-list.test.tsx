import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { resetVirtualRouter } from "../../../lib/routing";
import { OrganizationList } from "../OrganizationList";
import { createFakeInstance, renderWithOrbit } from "./harness";

beforeEach(() => {
  resetVirtualRouter();
});

const addOrg = (fake: ReturnType<typeof createFakeInstance>, id = "org_beta", name = "Beta Corp") => {
  fake.backend.orgs.push({ id, name, slug: id.replace("org_", "") });
  fake.backend.members[id] = [
    {
      userId: fake.backend.self.id,
      firstName: fake.backend.self.firstName,
      lastName: fake.backend.self.lastName,
      identifier: fake.backend.self.identifier,
      role: "org:member",
      permissions: [],
    },
  ];
};

describe("<OrganizationList />", () => {
  test("shows pending invitations first and accepts one", async () => {
    const fake = createFakeInstance();
    addOrg(fake, "org_beta");
    fake.backend.userInvitations.push({
      id: "inv_1",
      emailAddress: "ada@example.com",
      organizationId: "org_beta",
      role: "org:member",
    });
    renderWithOrbit(<OrganizationList />, fake);

    expect(await screen.findByText("You've been invited")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Accept invitation" }));

    await waitFor(() =>
      expect(
        fake.backend.calls.fetch.some(
          (call) => call.method === "POST" && call.path === "/me/organization_invitations/inv_1/accept",
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(fake.backend.calls.setActive).toEqual(["org_beta"]));
    expect(await screen.findByText("Choose an organization")).toBeTruthy();
  });

  test("skips the invitation screen", async () => {
    const fake = createFakeInstance();
    addOrg(fake, "org_beta");
    fake.backend.userInvitations.push({
      id: "inv_1",
      emailAddress: "ada@example.com",
      organizationId: "org_beta",
      role: "org:member",
    });
    renderWithOrbit(<OrganizationList />, fake);

    fireEvent.click(await screen.findByRole("button", { name: "Skip for now" }));
    expect(await screen.findByText("Choose an organization")).toBeTruthy();
  });

  test("selects an organization and redirects", async () => {
    const fake = createFakeInstance();
    addOrg(fake, "org_beta", "Beta Corp");
    renderWithOrbit(<OrganizationList afterSelectOrganizationUrl="/orgs/:id" />, fake);

    fireEvent.click(await screen.findByRole("button", { name: /Beta Corp/ }));

    await waitFor(() => expect(fake.backend.calls.setActive).toEqual(["org_beta"]));
    expect(fake.backend.calls.navigate).toEqual(["/orgs/org_beta"]);
  });

  test("selects the personal account", async () => {
    const fake = createFakeInstance();
    renderWithOrbit(<OrganizationList afterSelectPersonalUrl="/home" />, fake);

    fireEvent.click(await screen.findByRole("button", { name: /Personal account/ }));

    await waitFor(() => expect(fake.backend.calls.setActive).toEqual([null]));
    expect(fake.backend.calls.navigate).toEqual(["/home"]);
  });

  test("joins a suggested organization", async () => {
    const fake = createFakeInstance();
    addOrg(fake, "org_beta", "Beta Corp");
    fake.backend.members.org_beta = [];
    fake.backend.suggestions.push({ id: "sug_1", organizationId: "org_beta" });
    renderWithOrbit(<OrganizationList />, fake);

    expect(await screen.findByText("Suggested organizations")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Join" }));

    await waitFor(() => expect(fake.backend.calls.setActive).toEqual(["org_beta"]));
    expect(fake.backend.suggestions).toHaveLength(0);
  });
});
