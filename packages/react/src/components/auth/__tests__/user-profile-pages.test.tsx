import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { UserProfile } from "../user-profile";
import { UserButton } from "../user-button";
import type { UserOAuthApplicationResource, UserResource } from "../../../provider/types";
import { fakeMembership, fakeOrganization } from "../../../__tests__/helpers";
import { authEnvironment, authUser, renderAuth, setupAuth } from "./fake-auth";

const APPS: UserOAuthApplicationResource[] = [
  { id: "oa_1", name: "Analytics", access: "instance", billingPortalUrl: "https://pay.example.com/analytics" },
  {
    id: "oa_2",
    name: "Wiki",
    access: "membership",
    organization: { id: "org_1", name: "Acme" },
    billing_portal_url: null,
  },
  {
    id: "oa_3",
    name: "Contractor portal",
    access: "grant",
    organization: { id: "org_2", name: "Globex" },
    billingPortalUrl: "javascript:alert(1)",
  },
];

function harnessWith(apps: UserOAuthApplicationResource[] | null, overrides: Partial<UserResource> = {}) {
  const user = authUser({
    ...(apps ? { getOAuthApplications: vi.fn(async () => apps) } : {}),
    ...overrides,
  } as Partial<UserResource>);
  return setupAuth({ user });
}

const nav = () => screen.getByRole("navigation", { name: /Account/ });
const navLabels = () => Array.from(nav().querySelectorAll("button, a")).map((entry) => entry.textContent);

describe("UserProfile account pages", () => {
  it("lists the apps the user may use, with why and a billing link only for https portals", async () => {
    renderAuth(<UserProfile routing="virtual" />, harnessWith(APPS));
    fireEvent.click(await within(nav()).findByRole("button", { name: "Apps" }));

    const section = await screen.findByText("Applications you can sign in to with this account.");
    const list = section.closest("section")!;
    expect(within(list).getByText("Available to every account")).toBeTruthy();
    expect(within(list).getByText("Through your membership in Acme")).toBeTruthy();
    expect(within(list).getByText("Access granted by an administrator (Globex)")).toBeTruthy();

    const links = within(list).getAllByRole("link", { name: /Manage billing/ });
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute("href")).toBe("https://pay.example.com/analytics");
    expect(links[0]!.getAttribute("target")).toBe("_blank");
    expect(links[0]!.getAttribute("rel")).toBe("noopener noreferrer");
    expect(document.querySelector('a[href^="javascript"]')).toBeNull();
  });

  it("shows Billing only when an app has a billing portal", async () => {
    const { unmount } = renderAuth(<UserProfile routing="virtual" />, harnessWith(APPS));
    fireEvent.click(await within(nav()).findByRole("button", { name: "Billing" }));
    const rows = await screen.findAllByRole("link", { name: /Manage billing/ });
    expect(rows).toHaveLength(1);
    expect(screen.getByText("Analytics")).toBeTruthy();
    unmount();

    const withoutBilling = APPS.map((app) => ({ ...app, billingPortalUrl: null, billing_portal_url: null }));
    renderAuth(<UserProfile routing="virtual" />, harnessWith(withoutBilling));
    await within(nav()).findByRole("button", { name: "Apps" });
    expect(within(nav()).queryByRole("button", { name: "Billing" })).toBeNull();
  });

  it("hides Apps and Billing when the user may use no application or the SDK cannot list them", async () => {
    const empty = harnessWith([]);
    const { unmount } = renderAuth(<UserProfile routing="virtual" />, empty);
    await waitFor(() => expect(empty.instance.user?.getOAuthApplications).toHaveBeenCalled());
    expect(within(nav()).queryByRole("button", { name: "Apps" })).toBeNull();
    expect(within(nav()).queryByRole("button", { name: "Billing" })).toBeNull();
    unmount();

    const failing = harnessWith(null, { getOAuthApplications: vi.fn(async () => Promise.reject(new Error("404"))) } as never);
    renderAuth(<UserProfile routing="virtual" />, failing);
    await waitFor(() => expect(failing.instance.user?.getOAuthApplications).toHaveBeenCalled());
    expect(within(nav()).queryByRole("button", { name: "Apps" })).toBeNull();
  });

  it("renders the developer's billing content in place of the built-in page, even without portals", async () => {
    renderAuth(
      <UserProfile routing="virtual">
        <UserProfile.Page label="billing">
          <p>Your plan: Team</p>
        </UserProfile.Page>
      </UserProfile>,
      harnessWith([]),
    );
    fireEvent.click(await within(nav()).findByRole("button", { name: "Billing" }));
    expect(await screen.findByText("Your plan: Team")).toBeTruthy();
  });

  it("lists the organizations the user belongs to, with their role", async () => {
    const memberships = [
      fakeMembership({ id: "orgmem_1", role: "org:admin", roleName: "Admin", organization: fakeOrganization({ name: "Acme" }) }),
      fakeMembership({ id: "orgmem_2", role: "org:member", roleName: "Member", organization: fakeOrganization({ id: "org_2", name: "Globex" }) }),
    ];
    const harness = harnessWith([], {
      getOrganizationMemberships: vi.fn(async () => ({ data: memberships, totalCount: 2 })),
    } as never);
    renderAuth(<UserProfile routing="virtual" />, harness);
    fireEvent.click(await within(nav()).findByRole("button", { name: "Organizations" }));
    const section = (await screen.findByText("Organizations you belong to, and your role in each.")).closest("section")!;
    expect(await within(section).findByText("Globex")).toBeTruthy();
    expect(within(section).getByText("Acme")).toBeTruthy();
    expect(within(section).getByText("Member")).toBeTruthy();
  });

  it("leaves Organizations out when the instance has organizations turned off", async () => {
    const environment = authEnvironment();
    environment.organizationSettings = { ...environment.organizationSettings, enabled: false };
    const harness = setupAuth({ environment, user: authUser() });
    renderAuth(<UserProfile routing="virtual" />, harness);
    await within(nav()).findByRole("button", { name: "Security" });
    expect(within(nav()).queryByRole("button", { name: "Organizations" })).toBeNull();
  });
});

describe("UserProfile page customization", () => {
  it("reorders and hides built-in pages, keeping custom pages and links in the order written", async () => {
    renderAuth(
      <UserProfile routing="virtual">
        <UserProfile.Page label="security" />
        <UserProfile.Page label="Team" url="team">
          <p>Team page</p>
        </UserProfile.Page>
        <UserProfile.Link label="Help" url="https://example.com/help" />
        <UserProfile.Page label="profile" />
        <UserProfile.Page label="organizations" hidden />
      </UserProfile>,
      harnessWith(APPS),
    );
    await within(nav()).findByRole("button", { name: "Billing" });
    await within(nav()).findByRole("button", { name: "API keys" });
    // Unmentioned built-in pages keep their default order ahead of the written ones.
    expect(navLabels()).toEqual(["Apps", "Billing", "API keys", "Security", "Team", "Profile", "Help"]);
    expect(within(nav()).queryByRole("button", { name: "Organizations" })).toBeNull();
  });

  it("opens on the first page in the navigation order", async () => {
    renderAuth(
      <UserProfile routing="virtual">
        <UserProfile.Page label="profile" hidden />
      </UserProfile>,
      harnessWith([]),
    );
    expect(await screen.findByText("Passkeys")).toBeTruthy();
  });

  it("opens on defaultPage once a page that loads later appears", async () => {
    renderAuth(<UserProfile routing="virtual" defaultPage="billing" />, harnessWith(APPS));
    expect(await screen.findByText("Manage billing for the applications you use.")).toBeTruthy();
  });
});

describe("UserButton account modal", () => {
  it("passes UserProfilePage children to the account modal and opens Actions at their page", async () => {
    renderAuth(
      <UserButton>
        <UserButton.UserProfilePage label="Team" url="team">
          <p>Team page</p>
        </UserButton.UserProfilePage>
        <UserButton.MenuItems>
          <UserButton.Action label="Open team" open="team" />
        </UserButton.MenuItems>
      </UserButton>,
      harnessWith([]),
    );
    const trigger = await screen.findByRole("button", { name: "Account" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
    fireEvent.click(await screen.findByText("Open team"));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Team page")).toBeTruthy();
    // The profile page element was not rendered as a menu entry of its own.
    expect(screen.queryByRole("menuitem", { name: "Team" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Team" }).getAttribute("aria-current")).toBe("page");
  });

  it("reads pages wrapped in a fragment, like UserProfile does", async () => {
    const showTeam = true as boolean;
    renderAuth(
      <UserButton>
        {showTeam ? (
          <>
            <UserButton.UserProfilePage label="Team" url="team">
              <p>Team page</p>
            </UserButton.UserProfilePage>
            <UserButton.UserProfileLink label="Help" url="https://example.com/help" />
          </>
        ) : null}
        <UserButton.MenuItems>
          <UserButton.Action label="Open team" open="team" />
        </UserButton.MenuItems>
      </UserButton>,
      harnessWith([]),
    );
    const trigger = await screen.findByRole("button", { name: "Account" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
    fireEvent.click(await screen.findByText("Open team"));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Team page")).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: "Help" }).getAttribute("href")).toBe("https://example.com/help");
  });
});
