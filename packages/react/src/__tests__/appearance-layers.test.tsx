import { describe, expect, it } from "vitest";
import {
  VARIABLE_MAP,
  contrast,
  createElementResolver,
  cssVariablesFrom,
  dark,
  extendAppearance,
  flat,
  light,
  resolveAppearance,
  resolveAppearanceLayers,
  resolveElementClass,
  soft,
  themes,
  type BaseTheme,
} from "../appearance";

const brand: BaseTheme = { name: "brand", classNames: ["brand"], variables: { colorPrimary: "#111111", borderRadius: "2px" } };

describe("appearance precedence", () => {
  it("takes the themes from the last layer that sets baseTheme, then applies every layer's own values", () => {
    const resolved = resolveAppearanceLayers([
      { baseTheme: brand, variables: { borderRadius: "4px", fontFamily: "Provider" } },
      { baseTheme: soft, variables: { fontFamily: "Component" } },
    ]);
    expect(resolved.themes.map((theme) => theme.name)).toEqual(["soft"]);
    expect(resolved.theme.name).toBe("soft");
    // The provider's own values still sit over the component's theme; the component's own values win last.
    expect(resolved.variables.borderRadius).toBe("4px");
    expect(resolved.variables.fontFamily).toBe("Component");
    // The replaced theme contributes nothing.
    expect(resolved.variables.colorPrimary).toBeUndefined();
    expect(resolved.themeClassNames).not.toContain("brand");
  });

  it("keeps the scheme and the theme's variables together when layers set different base themes", () => {
    const lightOverDark = resolveAppearanceLayers([{ baseTheme: dark }, { baseTheme: light }]);
    expect(lightOverDark.themes).toEqual([light]);
    // No dark preset values written inline over a light card.
    expect(lightOverDark.cssVariables["--card"]).toBeUndefined();
    expect(lightOverDark.cssVariables["--primary"]).toBeUndefined();
    expect(lightOverDark.cssVariables["--foreground"]).toBeUndefined();

    const darkOverLight = resolveAppearanceLayers([{ baseTheme: light }, { baseTheme: dark }]);
    expect(darkOverLight.themes).toEqual([dark]);
    expect(darkOverLight.cssVariables["--card"]).toBe(dark.variables!.colorBackground);
    expect(darkOverLight.cssVariables["--primary-foreground"]).toBe("oklch(0.145 0 0)");

    // A component without baseTheme keeps the provider's.
    const inherited = resolveAppearanceLayers([{ baseTheme: dark }, { variables: { colorPrimary: "#ff0000" } }]);
    expect(inherited.themes).toEqual([dark]);
    expect(inherited.cssVariables["--primary"]).toBe("#ff0000");
  });

  it("merges several base themes in order inside one layer", () => {
    const resolved = resolveAppearance({ baseTheme: [soft, flat] });
    expect(resolved.variables.borderRadius).toBe(flat.variables!.borderRadius);
    expect(resolved.variables.shadowStrength).toBe(0);
    expect(resolved.rootClassName.split(" ")).toEqual(expect.arrayContaining(["orbitid-theme-soft", "orbitid-theme-flat"]));
  });

  it("is deterministic: the same layers always resolve to the same tokens", () => {
    const layers = [{ baseTheme: [dark, brand], variables: { colorText: "#000", colorForeground: "#fff" } }];
    const first = resolveAppearanceLayers(layers);
    const second = resolveAppearanceLayers(structuredClone(layers));
    expect(second.cssVariables).toEqual(first.cssVariables);
    // The current name wins over the older alias regardless of object key order.
    expect(first.cssVariables["--foreground"]).toBe("#fff");
    expect(resolveAppearance({ variables: { colorForeground: "#fff", colorText: "#000" } }).cssVariables["--foreground"]).toBe("#fff");
  });

  it("accumulates element overrides across layers instead of replacing them", () => {
    const provider = resolveAppearance({ elements: { card: "p-2 shadow-none", headerTitle: { style: { color: "red", fontSize: "1px" } } } });
    const component = extendAppearance(provider, {
      elements: { card: "p-6", headerTitle: { className: "italic", style: { fontSize: "20px" } } },
    });
    expect(resolveElementClass(component.elements.card, "p-4 rounded")).toBe("rounded shadow-none p-6");
    const resolver = createElementResolver(component);
    expect(resolver(["headerTitle"])).toEqual({
      className: "orbitid-headerTitle italic",
      style: { color: "red", fontSize: "20px" },
    });
    // The provider scope is untouched.
    expect(resolveElementClass(provider.elements.card)).toBe("p-2 shadow-none");
  });

  it("applies generic keys before specific keys, so the specific key wins a conflict", () => {
    const resolver = createElementResolver(
      resolveAppearance({ elements: { button: "rounded-none", buttonPrimary: "rounded-full", formButtonPrimary: "rounded-lg" } }),
    );
    const { className } = resolver(["button", "buttonPrimary", "formButtonPrimary"]);
    expect(className).toBe("orbitid-button rounded-none orbitid-buttonPrimary rounded-full orbitid-formButtonPrimary rounded-lg");
  });

  it("supports unstyled globally and per element, and a later layer can turn it back off", () => {
    expect(createElementResolver(resolveAppearance({ unstyled: true }))(["card"]).unstyled).toBe(true);
    expect(createElementResolver(resolveAppearance({ elements: { card: { unstyled: true } } }))(["card"]).unstyled).toBe(true);
    expect(createElementResolver(resolveAppearance({ elements: { card: "x" } }))(["card"]).unstyled).toBeUndefined();
    const off = resolveAppearanceLayers([{ unstyled: true }, { unstyled: false }]);
    expect(off.unstyled).toBe(false);
    expect(resolveElementClass({ unstyled: true, className: "mine" }, "theirs")).toBe("mine");
  });

  it("returns the parent untouched when a component has no appearance", () => {
    const parent = resolveAppearance({ variables: { colorPrimary: "#ff0000" } });
    expect(extendAppearance(parent, undefined)).toBe(parent);
  });

  it("keeps scheme classes out of the class names and exports every preset", () => {
    const resolved = resolveAppearance({ baseTheme: [light, dark, contrast] });
    expect(resolved.themeClassNames).toEqual(["orbitid-root", "orbitid-theme-contrast"]);
    expect(resolved.rootClassName.split(" ")).not.toContain("dark");
    expect(resolved.rootClassName.split(" ")).not.toContain("light");
    expect(Object.keys(themes)).toEqual(["defaultTheme", "light", "dark", "soft", "contrast", "flat"]);
  });
});

describe("variables → CSS custom properties", () => {
  it("maps every documented variable onto its custom properties", () => {
    for (const [name, mapping] of Object.entries(VARIABLE_MAP)) {
      const value = name === "fontSize" ? "16px" : name === "shadowStrength" ? "0.5" : "#123456";
      const css = cssVariablesFrom({ [name]: value });
      for (const target of mapping.targets) expect(css[target], `${name} → ${target}`).toBe(value);
    }
  });

  it("covers the core tokens", () => {
    const css = cssVariablesFrom({
      colorPrimary: "#2563eb",
      colorBackground: "#fafafa",
      colorForeground: "#111111",
      colorMuted: "#eeeeee",
      colorMutedForeground: "#555555",
      colorDanger: "#b91c1c",
      colorSuccess: "#15803d",
      colorWarning: "#a16207",
      colorInput: "#999999",
      colorInputBackground: "#ffffff",
      borderRadius: "10px",
      fontFamily: "Inter, sans-serif",
      fontSize: "15px",
      spacingUnit: "0.3rem",
      shadowStrength: 0,
    });
    expect(css).toMatchObject({
      "--primary": "#2563eb",
      "--primary-foreground": "oklch(0.985 0 0)",
      "--card": "#fafafa",
      "--popover": "#fafafa",
      "--foreground": "#111111",
      "--card-foreground": "#111111",
      "--muted": "#eeeeee",
      "--muted-foreground": "#555555",
      "--destructive": "#b91c1c",
      "--destructive-foreground": "oklch(0.985 0 0)",
      "--go": "#15803d",
      "--caution": "#a16207",
      "--input": "#999999",
      "--input-background": "#ffffff",
      "--radius": "10px",
      "--font-sans": "Inter, sans-serif",
      "--font-scale": "1.0714",
      "--spacing": "0.3rem",
      "--shadow-strength": "0",
    });
  });

  it("lets an explicit on-color beat the computed one", () => {
    const css = cssVariablesFrom({ colorPrimary: "#ffffff", colorPrimaryForeground: "#ff00ff" });
    expect(css["--primary-foreground"]).toBe("#ff00ff");
  });

  it("derives a font scale only from px and rem", () => {
    expect(cssVariablesFrom({ fontSize: "1rem" })["--font-scale"]).toBe("1.1429");
    expect(cssVariablesFrom({ fontSize: "large" })["--font-scale"]).toBeUndefined();
    expect(cssVariablesFrom({ fontSize: "large" })["--orbitid-font-size"]).toBe("large");
  });

  it("exposes unknown tokens under the orbitid prefix and skips empty values", () => {
    expect(cssVariablesFrom({ brandAccent: "#abc", empty: "", missing: undefined })).toEqual({ "--orbitid-brand-accent": "#abc" });
  });
});
