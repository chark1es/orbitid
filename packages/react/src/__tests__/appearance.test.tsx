import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { cssVariablesFrom, contrastForeground, dark, resolveAppearance, resolveElementClass } from "../appearance";
import { useAppearance, useElementClasses } from "../appearance/useAppearance";
import { renderWithProvider } from "./helpers";

describe("appearance", () => {
  it("merges base themes then explicit overrides", () => {
    const resolved = resolveAppearance({
      baseTheme: [dark],
      variables: { colorPrimary: "#ff0000", borderRadius: "12px", customToken: "1rem" },
      layout: { socialButtonsVariant: "iconButton" },
      elements: { card: "user-card" },
    });

    expect(resolved.rootClassName).toContain("orbitid-root");
    expect(resolved.rootClassName).toContain("dark");
    expect(resolved.variables.colorBackground).toBe(dark.variables?.colorBackground);
    expect(resolved.layout.socialButtonsVariant).toBe("iconButton");
    expect(resolved.elements.card).toBe("user-card");
    expect(resolved.cssVariables["--primary"]).toBe("#ff0000");
    expect(resolved.cssVariables["--primary-foreground"]).toBe(contrastForeground("#ff0000"));
    expect(resolved.cssVariables["--radius"]).toBe("12px");
    expect(resolved.cssVariables["--orbitid-custom-token"]).toBe("1rem");
  });

  it("defaults to the default theme", () => {
    const resolved = resolveAppearance();
    expect(resolved.theme.name).toBe("default");
    expect(resolved.rootClassName).toContain("orbitid-root");
    expect(resolved.cssVariables).toEqual({});
  });

  it("maps tokens and computes a legible foreground", () => {
    expect(cssVariablesFrom({ colorPrimary: "#ffffff" })["--primary-foreground"]).toBe("oklch(0.145 0 0)");
    expect(cssVariablesFrom({ colorPrimary: "#111111" })["--primary-foreground"]).toBe("oklch(0.985 0 0)");
    expect(cssVariablesFrom({ colorDanger: "red" })["--destructive"]).toBe("red");
    expect(cssVariablesFrom({ colorDanger: "red" })["--primary-foreground"]).toBeUndefined();
    expect(contrastForeground("not-a-color")).toBeUndefined();
    expect(cssVariablesFrom({ spacingUnit: "" })).toEqual({});
  });

  it("supports string, object and function element overrides", () => {
    expect(resolveElementClass("p-2", "p-4")).toBe("p-2");
    expect(resolveElementClass({ className: "rounded-none" }, "rounded-lg")).toBe("rounded-none");
    expect(resolveElementClass(() => "block")).toBe("block");
    expect(
      resolveElementClass(() => {
        throw new Error("boom");
      }, "fallback"),
    ).toBe("fallback");
  });

  it("applies appearance to the provider wrapper and elements", () => {
    function Probe() {
      const { layout } = useAppearance();
      const card = useElementClasses("card");
      return (
        <div data-testid="card" className={card("p-4")}>
          {layout.socialButtonsVariant}
        </div>
      );
    }

    renderWithProvider(<Probe />, {
      providerProps: {
        appearance: {
          baseTheme: dark,
          layout: { socialButtonsVariant: "blockButton" },
          elements: { card: "p-2", rootBox: "my-root" },
          variables: { colorPrimary: "#00ff00" },
        },
      },
    });

    const card = screen.getByTestId("card");
    expect(card.className).toBe("p-2");
    expect(card.textContent).toBe("blockButton");

    const root = card.parentElement!;
    expect(root.className).toContain("orbitid-root");
    expect(root.className).toContain("my-root");
    expect(root.className).toContain("dark");
    expect(root.getAttribute("data-orbitid-theme")).toBe("dark");
    expect(root.getAttribute("style")).toContain("--primary: #00ff00");
  });
});
