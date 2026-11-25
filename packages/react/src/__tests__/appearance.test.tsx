import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { cssVariablesFrom, contrastForeground, LIGHT_FOREGROUND, dark, resolveAppearance, resolveElementClass } from "../appearance";
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
    // The scheme comes from `useThemeScope()`; `rootClassName` also lands on the wrapper around the host's app.
    expect(resolved.rootClassName.split(" ")).not.toContain("dark");
    expect(resolved.themes).toContain(dark);
    expect(resolved.variables.colorBackground).toBe(dark.variables?.colorBackground);
    expect(resolved.layout.socialButtonsVariant).toBe("iconButton");
    expect(resolved.elements.card).toBe("user-card");
    expect(resolved.cssVariables["--primary"]).toBe("#ff0000");
    expect(resolved.cssVariables["--primary-foreground"]).toBe(contrastForeground("#ff0000"));
    expect(resolved.cssVariables["--radius"]).toBe("12px");
    expect(resolved.cssVariables["--orbitid-custom-token"]).toBe("1rem");
  });

  it("keeps a scheme class out of rootClassName even inside a multi-class entry", () => {
    const resolved = resolveAppearance({ baseTheme: { name: "brand", classNames: ["dark brand"] } });
    const classes = resolved.rootClassName.split(" ");
    expect(classes).toContain("brand");
    expect(classes).not.toContain("dark");
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
    // Mid greys and saturated red read better with dark text than with white.
    for (const mid of ["#999999", "#b0b0b0", "#ff0000"]) expect(contrastForeground(mid)).toBe("oklch(0.145 0 0)");
    expect(contrastForeground("#2b2522")).toBe(LIGHT_FOREGROUND);
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

  it("keeps appearance off the provider wrapper around the host app, but applies it to elements", () => {
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
          variables: { colorPrimary: "#00ff00", spacingUnit: "0.5rem" },
        },
      },
    });

    const card = screen.getByTestId("card");
    expect(card.className).toBe("p-2");
    expect(card.textContent).toBe("blockButton");

    // The host's own markup: no variables, no rootBox, no scheme class.
    const root = card.parentElement!;
    expect(root.className).toBe("orbitid-root");
    expect(root.getAttribute("style")).toBeNull();
    expect(root.getAttribute("data-orbitid-theme")).toBe("dark");
  });
});
