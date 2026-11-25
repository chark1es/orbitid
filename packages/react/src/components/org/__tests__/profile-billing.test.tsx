import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { resetVirtualRouter } from "../../../lib/routing";
import { OrganizationProfile } from "../OrganizationProfile";
import { OrganizationSwitcher } from "../OrganizationSwitcher";
import { useOrganizationBilling } from "../sections/BillingSection";
import { OrbitIDProvider } from "../../../provider";
import type { OrganizationResource } from "../../../provider";
import { createFakeInstance, renderWithOrbit } from "./harness";

beforeEach(() => {
  resetVirtualRouter();
});

afterEach(() => {
  window.location.hash = "";
});

type Fake = ReturnType<typeof createFakeInstance>;

function withPortal(fake: Fake, url: string | null) {
  fake.backend.orgs[0]!.billingPortalUrl = url;
}

function selfAs(fake: Fake, role: string, permissions: string[]) {
  const org = fake.backend.orgs[0]!;
  const self = fake.backend.members[org.id]!.find((member) => member.userId === fake.backend.self.id)!;
  self.role = role;
  self.permissions = permissions;
}

const nav = () => screen.getByRole("navigation", { name: "Organization" });
const navLabels = () => within(nav()).getAllByRole("button").map((button) => button.textContent);
const billingCalls = (fake: Fake) => fake.backend.calls.fetch.filter((call) => call.path.endsWith("/billing"));

describe("<OrganizationProfile /> billing", () => {
  test("a failed billing request shows an error on the Billing page instead of hiding it", async () => {
    const fake = createFakeInstance();
    withPortal(fake, "https://billing.example.com/acme");
    const failure = Promise.reject(new Error("network down"));
    failure.catch(() => undefined);
    fake.backend.billingGate = failure as unknown as Promise<void>;
    renderWithOrbit(<OrganizationProfile routing="virtual" />, fake);

    fireEvent.click(await screen.findByRole("button", { name: "Billing" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Manage billing/ })).toBeNull();
  });

  test("billing managers get a Billing page linking to the configured portal", async () => {
    const fake = createFakeInstance();
    withPortal(fake, "https://billing.example.com/acme");
    renderWithOrbit(<OrganizationProfile routing="virtual" />, fake);

    fireEvent.click(await screen.findByRole("button", { name: "Billing" }));
    const link = await screen.findByRole("link", { name: /Manage billing/ });
    expect(link.getAttribute("href")).toBe("https://billing.example.com/acme");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(navLabels()).toEqual(["General", "Members", "Billing", "API keys"]);
  });

  test("there is no Billing page when nothing is configured and no content is supplied", async () => {
    const fake = createFakeInstance();
    renderWithOrbit(<OrganizationProfile routing="virtual" />, fake);
    await screen.findByLabelText("Organization name");
    await waitFor(() => expect(billingCalls(fake)).toHaveLength(1));
    expect(screen.queryByRole("button", { name: "Billing" })).toBeNull();
  });

  test("members without org:sys_billing:manage never see billing, custom content included", async () => {
    const fake = createFakeInstance();
    withPortal(fake, "https://billing.example.com/acme");
    selfAs(fake, "org:member", ["org:sys_memberships:read", "org:sys_domains:read"]);
    renderWithOrbit(
      <OrganizationProfile routing="virtual">
        <OrganizationProfile.Page label="billing">
          <p>Our plans</p>
        </OrganizationProfile.Page>
      </OrganizationProfile>,
      fake,
    );
    await screen.findByLabelText("Organization name");
    expect(screen.queryByRole("button", { name: "Billing" })).toBeNull();
    expect(screen.queryByText("Our plans")).toBeNull();
    // No request that the server would refuse anyway.
    expect(billingCalls(fake)).toHaveLength(0);
  });

  test("a custom role holding only the billing permission gets the page", async () => {
    const fake = createFakeInstance();
    withPortal(fake, "https://billing.example.com/acme");
    selfAs(fake, "org:billing", ["org:sys_billing:manage"]);
    renderWithOrbit(<OrganizationProfile routing="virtual" />, fake);
    fireEvent.click(await screen.findByRole("button", { name: "Billing" }));
    expect(await screen.findByRole("link", { name: /Manage billing/ })).toBeTruthy();
  });

  test("developer content replaces the built-in billing page and keeps its gate", async () => {
    const fake = createFakeInstance();
    renderWithOrbit(
      <OrganizationProfile routing="virtual">
        <OrganizationProfile.Page label="billing">
          <p>Our plans</p>
        </OrganizationProfile.Page>
      </OrganizationProfile>,
      fake,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Billing" }));
    expect(await screen.findByText("Our plans")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Manage billing/ })).toBeNull();
  });

  test("a portal URL that is not https is never rendered as a link", async () => {
    const fake = createFakeInstance();
    withPortal(fake, "javascript:alert(1)");
    renderWithOrbit(<OrganizationProfile routing="virtual" />, fake);
    await screen.findByLabelText("Organization name");
    await waitFor(() => expect(billingCalls(fake)).toHaveLength(1));
    expect(screen.queryByRole("button", { name: "Billing" })).toBeNull();
    expect(document.querySelector('a[href^="javascript"]')).toBeNull();
  });
});

describe("<OrganizationProfile /> page customization", () => {
  test("reorders and hides built-in pages, with custom pages and links in the order written", async () => {
    const fake = createFakeInstance();
    withPortal(fake, "https://billing.example.com/acme");
    renderWithOrbit(
      <OrganizationProfile routing="virtual">
        <OrganizationProfile.Page label="members" />
        <OrganizationProfile.Page label="Team" url="team">
          <p>Custom team page</p>
        </OrganizationProfile.Page>
        <OrganizationProfile.Link label="Docs" url="https://docs.example.com" />
        <OrganizationProfile.Page label="general" />
        <OrganizationProfile.Page label="api-keys" hidden />
      </OrganizationProfile>,
      fake,
    );
    await screen.findByRole("button", { name: "Billing" });
    const entries = Array.from(nav().querySelectorAll("button, a")).map((entry) => entry.textContent);
    // Billing is not mentioned, so it keeps its default place ahead of the written order.
    expect(entries).toEqual(["Billing", "Members", "Team", "Docs", "General"]);
    expect(screen.queryByRole("button", { name: "API keys" })).toBeNull();
  });

  test("a custom page at a built-in slug overrides that page", async () => {
    const fake = createFakeInstance();
    selfAs(fake, "org:member", ["org:sys_memberships:read", "org:sys_domains:read"]);
    renderWithOrbit(
      <OrganizationProfile routing="virtual">
        <OrganizationProfile.Page label="Plans" url="billing">
          <p>Plans page</p>
        </OrganizationProfile.Page>
      </OrganizationProfile>,
      fake,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Plans" }));
    expect(await screen.findByText("Plans page")).toBeTruthy();
    expect(billingCalls(fake)).toHaveLength(0);
  });

  test("OrganizationSwitcher passes profile pages to the profile it opens", async () => {
    const fake = createFakeInstance();
    renderWithOrbit(
      <OrganizationSwitcher>
        <OrganizationSwitcher.OrganizationProfilePage label="Team" url="team">
          <p>Custom team page</p>
        </OrganizationSwitcher.OrganizationProfilePage>
      </OrganizationSwitcher>,
      fake,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Open organization switcher" }));
    fireEvent.click(await screen.findByRole("button", { name: "Manage organization" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: "Team" }));
    expect(await within(dialog).findByText("Custom team page")).toBeTruthy();
  });
});

describe("<OrganizationProfile /> edge cases", () => {
  test("renders an empty panel instead of crashing when no page is left", async () => {
    const fake = createFakeInstance();
    selfAs(fake, "org:member", ["org:sys_memberships:read", "org:sys_domains:read"]);
    renderWithOrbit(
      <OrganizationProfile routing="virtual">
        <OrganizationProfile.Page label="general" hidden />
        <OrganizationProfile.Page label="members" hidden />
      </OrganizationProfile>,
      fake,
    );
    expect(await screen.findByRole("heading", { name: "Acme" })).toBeTruthy();
    expect(within(nav()).queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByLabelText("Organization name")).toBeNull();
  });

  test("a deep link to Billing waits for the portal instead of flashing General", async () => {
    let release: () => void = () => undefined;
    const fake = createFakeInstance();
    fake.backend.billingGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    withPortal(fake, "https://billing.example.com/acme");
    window.location.hash = "#/billing";
    renderWithOrbit(<OrganizationProfile routing="hash" />, fake);

    await within(await screen.findByRole("navigation", { name: "Organization" })).findByRole("button", { name: "General" });
    await waitFor(() => expect(billingCalls(fake)).toHaveLength(1));
    expect(screen.queryByLabelText("Organization name")).toBeNull();
    expect(within(nav()).getByRole("button", { name: "General" }).getAttribute("aria-current")).toBeNull();

    release();
    expect(await screen.findByRole("link", { name: /Manage billing/ })).toBeTruthy();
    expect(within(nav()).getByRole("button", { name: "Billing" }).getAttribute("aria-current")).toBe("page");
  });

  test("links open in a new tab like UserProfile links, and repeated links are listed once", async () => {
    const fake = createFakeInstance();
    renderWithOrbit(
      <OrganizationProfile routing="virtual">
        <OrganizationProfile.Link label="Docs" url="https://docs.example.com" />
        <OrganizationProfile.Link label="Docs again" url="https://docs.example.com" />
      </OrganizationProfile>,
      fake,
    );
    const links = await within(await screen.findByRole("navigation", { name: "Organization" })).findAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]!.textContent).toBe("Docs");
    expect(links[0]!.getAttribute("target")).toBe("_blank");
    expect(links[0]!.getAttribute("rel")).toBe("noreferrer");
  });
});

describe("useOrganizationBilling", () => {
  function Probe({ organization }: { organization: OrganizationResource }) {
    const billing = useOrganizationBilling(organization, true);
    return <span data-testid="billing">{billing.loaded ? (billing.portalUrl ?? "none") : "loading"}</span>;
  }

  test("never shows the previous organization's portal while the next one loads", async () => {
    const fake = createFakeInstance();
    const acme = { id: "org_acme", getBilling: () => Promise.resolve({ portalUrl: "https://billing.example.com/acme" }) };
    let releaseGlobex: () => void = () => undefined;
    const globex = {
      id: "org_globex",
      getBilling: () =>
        new Promise((resolve) => {
          releaseGlobex = () => resolve({ portalUrl: "https://billing.example.com/globex" });
        }),
    };
    const result = renderWithOrbit(<Probe organization={acme as unknown as OrganizationResource} />, fake);
    await waitFor(() => expect(screen.getByTestId("billing").textContent).toBe("https://billing.example.com/acme"));

    result.rerender(
      <OrbitIDProvider orbit={fake.instance} publishableKey="pk_test_harness">
        <Probe organization={globex as unknown as OrganizationResource} />
      </OrbitIDProvider>,
    );
    expect(screen.getByTestId("billing").textContent).toBe("loading");
    releaseGlobex();
    await waitFor(() => expect(screen.getByTestId("billing").textContent).toBe("https://billing.example.com/globex"));
  });
});
