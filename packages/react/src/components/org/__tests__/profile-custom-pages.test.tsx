import { describe, expect, test } from "vitest";
import { OrganizationProfile } from "../OrganizationProfile";
import { renderWithOrbit, createFakeInstance } from "./harness";
import { fireEvent, screen } from "@testing-library/react";
import { resetVirtualRouter } from "../../../lib/routing";
import { beforeEach } from "vitest";

beforeEach(() => resetVirtualRouter());

describe("<OrganizationProfile /> custom pages", () => {
  test("renders OrganizationProfile.Page sections and OrganizationProfile.Link entries", async () => {
    const fake = createFakeInstance();
    renderWithOrbit(
      <OrganizationProfile routing="virtual">
        <OrganizationProfile.Page label="Team" url="team">
          <p>Custom team page</p>
        </OrganizationProfile.Page>
        <OrganizationProfile.Link label="Docs" url="https://docs.example.com" />
      </OrganizationProfile>,
      fake,
    );

    const link = await screen.findByRole("link", { name: "Docs" });
    expect(link.getAttribute("href")).toBe("https://docs.example.com");

    fireEvent.click(screen.getByRole("button", { name: "Team" }));
    expect(await screen.findByText("Custom team page")).toBeTruthy();
    expect(screen.queryByLabelText("Organization name")).toBeNull();
  });

  test("appearance overrides apply to the component root", async () => {
    const fake = createFakeInstance();
    const { container } = renderWithOrbit(
      <OrganizationProfile
        routing="virtual"
        appearance={{ elements: { rootBox: "custom-org-root" }, variables: { colorPrimary: "#ff0000" } }}
      />,
      fake,
    );
    await screen.findByLabelText("Organization name");
    const root = container.querySelector(".custom-org-root") as HTMLElement | null;
    expect(root).toBeTruthy();
    expect(root?.getAttribute("style")).toContain("--primary");
  });
});
