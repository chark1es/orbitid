import { beforeEach, describe, expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { resetVirtualRouter } from "../../../lib/routing";
import { useOrganization, useOrganizationList } from "../../../hooks";
import { APIKeys } from "../APIKeys";
import { CreateOrganization } from "../CreateOrganization";
import { OrganizationList } from "../OrganizationList";
import { OrganizationProfile } from "../OrganizationProfile";
import { OrganizationSwitcher } from "../OrganizationSwitcher";
import { createFakeInstance, renderWithOrbit } from "./harness";

beforeEach(() => {
  resetVirtualRouter();
});

const disabledInstance = () => createFakeInstance({ organizationSettings: { enabled: false } });

describe("organization components while organizations are turned off", () => {
  test("the switcher renders nothing, so no stray control is left in a navbar", () => {
    const { container } = renderWithOrbit(<OrganizationSwitcher />, disabledInstance());
    expect(screen.queryByRole("button", { name: "Open organization switcher" })).toBeNull();
    expect(container.textContent).toBe("");
  });

  test.each([
    ["OrganizationList", <OrganizationList key="list" />],
    ["OrganizationProfile", <OrganizationProfile key="profile" />],
    ["CreateOrganization", <CreateOrganization key="create" />],
  ])("%s is locked behind a notice and offers no create action", async (_name, element) => {
    renderWithOrbit(element, disabledInstance());
    expect(await screen.findByText("Organizations are turned off")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /create organization/i })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  test("does not fetch organization data for a locked component", async () => {
    const fake = disabledInstance();
    renderWithOrbit(<OrganizationProfile />, fake);
    await screen.findByText("Organizations are turned off");
    expect(fake.backend.calls.fetch).toEqual([]);
  });

  test("organization API keys are locked, but a user's own API keys are not", async () => {
    const fake = disabledInstance();
    const { unmount } = renderWithOrbit(<APIKeys type="organization" />, fake);
    expect(await screen.findByText("Organizations are turned off")).toBeTruthy();
    unmount();

    renderWithOrbit(<APIKeys type="user" />, disabledInstance());
    await screen.findByRole("heading", { name: /api keys/i }).catch(() => undefined);
    expect(screen.queryByText("Organizations are turned off")).toBeNull();
  });

  test("components still render when organizations are on", async () => {
    renderWithOrbit(<OrganizationList />, createFakeInstance());
    expect(screen.queryByText("Organizations are turned off")).toBeNull();
  });
});

function PublicOrganizationHooks() {
  const org = useOrganization({ apiKeys: true });
  const list = useOrganizationList();
  return <span>{org.organization?.id ?? "Personal account"}:{list.userMemberships.data.length}</span>;
}

test("public organization hooks issue no requests and expose no active org while disabled", async () => {
  const fake = disabledInstance();
  renderWithOrbit(<PublicOrganizationHooks />, fake);
  await waitFor(() => expect(screen.getByText("Personal account:0")).toBeTruthy());
  expect(fake.backend.calls.fetch).toEqual([]);
});
