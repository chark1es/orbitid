import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import AppearancePage from "./settings-appearance";
import { instanceBody, mockApi, renderPage } from "./_config/__tests__/harness";
import { DEFAULT_DRAFT, appearanceSnippet, draftVariables } from "./_appearance/draft";

const preview = () => screen.getByTestId("branding-preview");

describe("appearance preview", () => {
  it("follows the saved theme", async () => {
    mockApi({ instance: instanceBody((settings) => (settings.branding.theme = "dark")) });
    renderPage(<AppearancePage />);

    await screen.findByTestId("branding-preview");
    expect(preview().dataset.scheme).toBe("dark");
    expect(preview().className).toContain("dark");
    expect(screen.getByRole("button", { name: "dark" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "light" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("flips between light and dark without changing the saved theme", async () => {
    const calls = mockApi({ instance: instanceBody((settings) => (settings.branding.theme = "light")) });
    renderPage(<AppearancePage />);

    await screen.findByTestId("branding-preview");
    expect(preview().dataset.scheme).toBe("light");

    fireEvent.click(screen.getByRole("button", { name: "dark" }));
    expect(preview().dataset.scheme).toBe("dark");
    expect(preview().className).toContain("dark");

    fireEvent.click(screen.getByRole("button", { name: "light" }));
    expect(preview().dataset.scheme).toBe("light");
    expect(preview().className).not.toContain("dark");
    // Without a `light` scope the preview would inherit dark tokens when the dashboard itself is dark.
    expect(preview().classList.contains("light")).toBe(true);
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
    // A preview flip is not a settings change.
    expect(screen.queryByText(/unsaved changes/i)).toBeNull();
  });

  it("gives the colour picker a #rrggbb value even when the text field holds a shorthand hex", async () => {
    mockApi({ instance: instanceBody((settings) => (settings.branding.primaryColor = "#f80")) });
    renderPage(<AppearancePage />);

    await screen.findByTestId("branding-preview");
    expect((screen.getByLabelText("Primary color picker") as HTMLInputElement).value).toBe("#ff8800");
  });

  it("uses the operating system scheme for the system theme", async () => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes("dark"),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    mockApi({ instance: instanceBody((settings) => (settings.branding.theme = "system")) });
    renderPage(<AppearancePage />);

    await screen.findByTestId("branding-preview");
    expect(preview().dataset.scheme).toBe("dark");
  });
});

describe("component theme playground", () => {
  it("drives the preview with the instance's brand color and starts with an empty snippet", async () => {
    mockApi({ instance: instanceBody((settings) => {
      settings.branding.theme = "light";
      settings.branding.primaryColor = "#2563eb";
    }) });
    renderPage(<AppearancePage />);

    await screen.findByTestId("branding-preview");
    expect(preview().style.getPropertyValue("--primary")).toBe("#2563eb");
    expect(screen.getByTestId("appearance-snippet").textContent).toContain("const appearance = {}");
  });

  it("keeps a dark brand color off a dark preview, as the components do", async () => {
    mockApi({ instance: instanceBody((settings) => {
      settings.branding.theme = "dark";
      settings.branding.primaryColor = "#111111";
    }) });
    renderPage(<AppearancePage />);

    await screen.findByTestId("branding-preview");
    expect(preview().style.getPropertyValue("--primary")).toBe("");
  });
});

describe("appearance snippet", () => {
  it("lists only what changed, importing the preset it uses", () => {
    expect(appearanceSnippet(DEFAULT_DRAFT)).toBe("// Defaults: nothing to configure.\nconst appearance = {};");
    const snippet = appearanceSnippet({ ...DEFAULT_DRAFT, preset: "soft", borderRadius: "0.75rem", font: "serif", shadowStrength: "0" });
    expect(snippet).toBe(
      [
        'import { soft } from "@orbitid/react";',
        "",
        "const appearance = {",
        "  baseTheme: soft,",
        "  variables: {",
        '    borderRadius: "0.75rem",',
        '    fontFamily: "ui-serif, Georgia, serif",',
        "    shadowStrength: 0,",
        "  },",
        "};",
      ].join("\n"),
    );
  });

  it("maps the draft onto appearance variables", () => {
    expect(draftVariables({ ...DEFAULT_DRAFT, fontSize: "15px", spacingUnit: "0.28rem" }, "#ff0000")).toEqual({
      colorPrimary: "#ff0000",
      fontSize: "15px",
      spacingUnit: "0.28rem",
    });
  });
});
