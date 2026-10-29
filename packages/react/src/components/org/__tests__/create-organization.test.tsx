import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { resetVirtualRouter } from "../../../lib/routing";
import { CreateOrganization } from "../CreateOrganization";
import { createFakeInstance, renderWithOrbit } from "./harness";

beforeEach(() => {
  resetVirtualRouter();
});

const fillDetails = async (name: string) => {
  const nameInput = await screen.findByLabelText("Organization name");
  fireEvent.change(nameInput, { target: { value: name } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
};

describe("<CreateOrganization />", () => {
  test("pre-disables creation when the user reached the organization limit", async () => {
    const fake = createFakeInstance({
      organizationSettings: { max_created_organizations_per_user: 1 },
    });
    renderWithOrbit(<CreateOrganization />, fake);

    expect(
      await screen.findByText(
        "You have created the maximum number of organizations your account allows, 1. Delete one you created or ask an administrator to raise the limit.",
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Organization name")).toBeNull();
  });

  test("auto-generates the slug until the user edits it", async () => {
    const fake = createFakeInstance();
    renderWithOrbit(<CreateOrganization />, fake);

    const nameInput = await screen.findByLabelText("Organization name");
    fireEvent.change(nameInput, { target: { value: "Beta Corp" } });
    const slugInput = screen.getByLabelText("Slug") as HTMLInputElement;
    expect(slugInput.value).toBe("beta-corp");

    fireEvent.change(slugInput, { target: { value: "beta-custom" } });
    fireEvent.change(nameInput, { target: { value: "Gamma Ltd" } });
    expect((screen.getByLabelText("Slug") as HTMLInputElement).value).toBe("beta-custom");
  });

  test("creates the organization, activates it and skips the invite step", async () => {
    const fake = createFakeInstance();
    renderWithOrbit(
      <CreateOrganization afterCreateOrganizationUrl="/orgs/:id" skipInvitationScreen />,
      fake,
    );

    await fillDetails("Beta Corp");

    await waitFor(() => expect(fake.backend.orgs).toHaveLength(2));
    const created = fake.backend.orgs[1]!;
    expect(created.name).toBe("Beta Corp");
    expect(created.slug).toBe("beta-corp");
    await waitFor(() => expect(fake.backend.calls.setActive).toEqual([created.id]));
    await waitFor(() => expect(fake.backend.calls.navigate).toEqual([`/orgs/${created.id}`]));
  });

  test("shows the invite step and sends invitations with the chosen role", async () => {
    const fake = createFakeInstance();
    renderWithOrbit(<CreateOrganization afterCreateOrganizationUrl="/done" />, fake);

    await fillDetails("Beta Corp");
    expect(await screen.findByText("Invite members")).toBeTruthy();

    const emailInput = screen.getByLabelText("Email addresses");
    fireEvent.change(emailInput, { target: { value: "new@example.com" } });
    fireEvent.keyDown(emailInput, { key: "Enter" });

    fireEvent.click(screen.getByRole("combobox", { name: "Role" }));
    fireEvent.click(await screen.findByRole("option", { name: "Admin" }));
    fireEvent.click(screen.getByRole("button", { name: "Send invitations" }));

    await waitFor(() =>
      expect(fake.backend.calls.invites).toEqual([
        { emailAddresses: ["new@example.com"], role: "org:admin" },
      ]),
    );
    await waitFor(() => expect(fake.backend.calls.navigate).toEqual(["/done"]));
  });

  test("skips the invite step", async () => {
    const fake = createFakeInstance();
    renderWithOrbit(<CreateOrganization afterCreateOrganizationUrl="/done" />, fake);

    await fillDetails("Beta Corp");
    expect(await screen.findByText("Invite members")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));

    await waitFor(() => expect(fake.backend.calls.navigate).toEqual(["/done"]));
    expect(fake.backend.calls.invites).toHaveLength(0);
  });

  test("reports a taken slug on the slug field", async () => {
    const fake = createFakeInstance({ orgDefaults: { name: "Taken", slug: "taken" } });
    const form = renderWithOrbit(<CreateOrganization />, fake);

    await fillDetails("Taken");

    expect(await screen.findByText("This slug is already taken.")).toBeTruthy();
    expect(fake.backend.orgs).toHaveLength(1);
    const slugInput = within(form.container).getByLabelText("Slug") as HTMLInputElement;
    expect(slugInput.getAttribute("aria-invalid")).toBe("true");
  });

  test("respects organizations.creation_enabled", async () => {
    const fake = createFakeInstance({ organizationSettings: { creationEnabled: false } });
    renderWithOrbit(<CreateOrganization />, fake);

    expect(
      await screen.findByText("You are not allowed to create organizations."),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Organization name")).toBeNull();
  });
});
