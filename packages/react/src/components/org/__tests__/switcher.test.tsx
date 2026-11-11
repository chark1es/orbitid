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
    // 448, the small-form token: the create form is a three-field dialog, not a 512px sheet.
    expect(dialog.className).toContain("sm:max-w-md");
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

  test("lets the trigger shrink in a narrow header instead of forcing the bar wider", async () => {
    const fake = createFakeInstance();
    renderWithOrbit(<OrganizationSwitcher />, fake);

    const trigger = await screen.findByRole("button", { name: "Open organization switcher" });
    const root = trigger.closest(".orbitid-org")!;
    expect(root.className).toContain("w-auto");
    expect(root.className).toContain("min-w-0");
    expect(root.className).toContain("max-w-full");
    expect(trigger.className).toContain("min-w-0");
    expect(trigger.className).toContain("max-w-full");
    expect(trigger.className.split(/\s+/)).not.toContain("w-full");
    const label = within(trigger).getByText("Acme");
    expect(label.className).toContain("min-w-0");
    expect(label.className).toContain("truncate");
    // At 375px the text column leaves; the avatar and chevron keep the control identifiable.
    const column = label.parentElement!;
    expect(column.className).toContain("hidden");
    expect(column.className).toContain("sm:flex");
  });

  test("truncates a long active name and a long row instead of widening the bar", async () => {
    const fake = createFakeInstance();
    const longName = `Starfleet ${"Operations ".repeat(20)}`.trim();
    fake.backend.orgs[0]!.name = longName;
    renderWithOrbit(<OrganizationSwitcher />, fake);

    const trigger = await screen.findByRole("button", { name: "Open organization switcher" });
    expect(trigger.className).toContain("min-w-0");
    expect(trigger.className).toContain("sm:max-w-[16rem]");

    fireEvent.click(trigger);
    const row = await screen.findByRole("button", { name: new RegExp("Starfleet") });
    expect(row.className).toContain("min-w-0");
    expect(within(row).getByText(longName).className).toContain("truncate");
  });
});
