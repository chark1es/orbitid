import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { resetVirtualRouter } from "../../../lib/routing";
import { OrganizationSwitcher } from "../OrganizationSwitcher";
import { createFakeInstance, renderWithOrbit } from "./harness";

beforeEach(() => {
  resetVirtualRouter();
});

const addSecondOrganization = (
  fake: ReturnType<typeof createFakeInstance>,
  role: "org:admin" | "org:member" = "org:member",
) => {
  fake.backend.orgs.push({ id: "org_beta", name: "Beta Corp", slug: "beta" });
  fake.backend.members.org_beta = [
    {
      userId: fake.backend.self.id,
      firstName: fake.backend.self.firstName,
      lastName: fake.backend.self.lastName,
      identifier: fake.backend.self.identifier,
      role,
      permissions: role === "org:admin" ? ["org:sys_profile:manage"] : [],
    },
  ];
};

describe("<OrganizationSwitcher />", () => {
  test("lists memberships, roles and the personal account, then switches organizations", async () => {
    const fake = createFakeInstance();
    addSecondOrganization(fake);
    renderWithOrbit(
      <OrganizationSwitcher afterSelectOrganizationUrl={(org) => `/orgs/${org.id}`} />,
      fake,
    );

    const trigger = await screen.findByRole("button", { name: "Open organization switcher" });
    expect(trigger.textContent).toContain("Acme");

    fireEvent.click(trigger);
    expect(await screen.findByText("Personal account")).toBeTruthy();

    const beta = await screen.findByRole("button", { name: /Beta Corp/ });
    fireEvent.click(beta);

    await waitFor(() => expect(fake.backend.calls.setActive).toEqual(["org_beta"]));
    expect(fake.backend.calls.navigate).toEqual(["/orgs/org_beta"]);
  });

  test("selecting the personal account clears the active organization", async () => {
    const fake = createFakeInstance();
    renderWithOrbit(<OrganizationSwitcher afterSelectPersonalUrl="/home" />, fake);

    fireEvent.click(await screen.findByRole("button", { name: "Open organization switcher" }));
    fireEvent.click(await screen.findByRole("button", { name: /Personal account/ }));

    await waitFor(() => expect(fake.backend.calls.setActive).toEqual([null]));
    expect(fake.backend.calls.navigate).toEqual(["/home"]);
  });

  test("accepts a pending invitation and activates the invited organization", async () => {
    const fake = createFakeInstance();
    addSecondOrganization(fake, "org:admin");
    fake.backend.userInvitations.push({
      id: "inv_1",
      emailAddress: "ada@example.com",
      organizationId: "org_beta",
      role: "org:admin",
    });
    renderWithOrbit(
      <OrganizationSwitcher afterSelectOrganizationUrl={(org) => `/orgs/${org.id}`} />,
      fake,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open organization switcher" }));
    const join = await screen.findByRole("button", { name: "Join" });
    fireEvent.click(join);

    await waitFor(() =>
      expect(
        fake.backend.calls.fetch.some(
          (call) => call.method === "POST" && call.path === "/me/organization_invitations/inv_1/accept",
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(fake.backend.calls.setActive).toEqual(["org_beta"]));
    await waitFor(() => expect(fake.backend.calls.navigate).toEqual(["/orgs/org_beta"]));
    expect(fake.backend.userInvitations).toHaveLength(0);
  });

  test("accepts a suggested organization", async () => {
    const fake = createFakeInstance();
    addSecondOrganization(fake);
    fake.backend.suggestions.push({ id: "sug_1", organizationId: "org_beta" });
    renderWithOrbit(<OrganizationSwitcher />, fake);

    fireEvent.click(await screen.findByRole("button", { name: "Open organization switcher" }));
    expect(await screen.findByText("Suggestions")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Join" }));

    await waitFor(() => expect(fake.backend.calls.setActive).toEqual(["org_beta"]));
    expect(fake.backend.suggestions).toHaveLength(0);
  });

  test("creates an organization from the modal and redirects", async () => {
    const fake = createFakeInstance();
    renderWithOrbit(
      <OrganizationSwitcher
        skipInvitationScreen
        afterCreateOrganizationUrl={(org) => `/orgs/${org.id}`}
      />,
      fake,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open organization switcher" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create organization" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Organization name"), {
      target: { value: "New Co" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(fake.backend.orgs).toHaveLength(2));
    const created = fake.backend.orgs[1]!;
    await waitFor(() => expect(fake.backend.calls.navigate).toEqual([`/orgs/${created.id}`]));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("navigation modes push the configured profile and create URLs", async () => {
    const fake = createFakeInstance();
    renderWithOrbit(
      <OrganizationSwitcher
        createOrganizationMode="navigation"
        organizationProfileMode="navigation"
        organizationProfileUrl="/settings/org"
        createOrganizationUrl="/new-org"
      />,
      fake,
    );

    const trigger = await screen.findByRole("button", { name: "Open organization switcher" });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("button", { name: "Manage organization" }));
    await waitFor(() => expect(fake.backend.calls.navigate).toEqual(["/settings/org"]));

    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("button", { name: "Create organization" }));
    await waitFor(() => expect(fake.backend.calls.navigate).toEqual(["/settings/org", "/new-org"]));
  });

  test("hidePersonal removes the personal account entry", async () => {
    const fake = createFakeInstance();
    renderWithOrbit(<OrganizationSwitcher hidePersonal />, fake);

    fireEvent.click(await screen.findByRole("button", { name: "Open organization switcher" }));
    expect(screen.queryByRole("button", { name: /Personal account/ })).toBeNull();
  });
});
