import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DARK_FOREGROUND,
  LIGHT_FOREGROUND,
  contrastForeground,
  createElementResolver,
  cssVariablesFrom,
  dark,
  flattenElement,
  light,
  resolveAppearance,
  resolveAppearanceLayers,
  type Appearance,
  type BaseTheme,
} from "../appearance";
import { resetDevWarnings } from "../appearance/warn";

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetDevWarnings();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe("older variable names", () => {
  it("beat a preset's current name in the same layer", () => {
    const resolved = resolveAppearance({ baseTheme: dark, variables: { colorText: "#ff0000", colorTextSecondary: "#00ff00" } });
    expect(resolved.cssVariables["--foreground"]).toBe("#ff0000");
    expect(resolved.cssVariables["--muted-foreground"]).toBe("#00ff00");
  });

  it("in a later layer beat an earlier layer's current name", () => {
    const resolved = resolveAppearanceLayers([
      { variables: { colorForeground: "#111111", colorInputForeground: "#222222" } },
      { variables: { colorText: "#ff0000", colorInputText: "#333333" } },
    ]);
    expect(resolved.cssVariables["--foreground"]).toBe("#ff0000");
    expect(resolved.cssVariables["--input-foreground"]).toBe("#333333");
    expect(resolved.variables.colorText).toBeUndefined();
  });

  it("lose to the current name inside one layer", () => {
    expect(cssVariablesFrom({ colorText: "#000000", colorForeground: "#ffffff" })["--foreground"]).toBe("#ffffff");
  });
});

describe("automatic on-colors", () => {
  it.each([
    ["the dark preset's oklch primary", dark.variables!.colorPrimary as string, DARK_FOREGROUND],
    ["a dark oklch", "oklch(0.21 0.006 60)", LIGHT_FOREGROUND],
    ["oklch with a percentage and alpha", "oklch(95% 0.01 85 / 0.9)", DARK_FOREGROUND],
    ["rgb()", "rgb(37, 99, 235)", LIGHT_FOREGROUND],
    ["rgba() with spaces", "rgba(250 250 250 / 50%)", DARK_FOREGROUND],
    ["hsl()", "hsl(220 90% 20%)", LIGHT_FOREGROUND],
    ["hsla() light", "hsla(60, 100%, 85%, 1)", DARK_FOREGROUND],
    ["short hex", "#fff", DARK_FOREGROUND],
    ["hex with alpha", "#111111cc", LIGHT_FOREGROUND],
  ])("reads %s", (_label, color, expected) => {
    expect(contrastForeground(color)).toBe(expected);
    expect(cssVariablesFrom({ colorPrimary: color })["--primary-foreground"]).toBe(expected);
  });

  it("keeps the theme's foreground for a color it cannot read, and says so in development", () => {
    const css = cssVariablesFrom({ colorPrimary: "var(--brand)" });
    expect(css["--primary"]).toBe("var(--brand)");
    expect(css["--primary-foreground"]).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("colorPrimaryForeground"));
  });

  it("does not warn when the on-color is given", () => {
    cssVariablesFrom({ colorPrimary: "var(--brand)", colorPrimaryForeground: "white" });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("fontSize", () => {
  it("warns that only px and rem scale", () => {
    expect(cssVariablesFrom({ fontSize: "large" })["--font-scale"]).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("px or rem"));
  });
});

describe("malformed input", () => {
  const cases: Array<[string, unknown]> = [
    ["baseTheme: null", { baseTheme: null }],
    ["an undefined entry", { baseTheme: [dark, undefined] }],
    ["a null entry", { baseTheme: [null, dark] }],
    ["a number", { baseTheme: 3 }],
    ["variables: null", { variables: null }],
    ["elements: null", { elements: null }],
    ["layout: a string", { layout: "nope" }],
    ["a theme with null parts", { baseTheme: { name: "x", variables: null, elements: null, layout: null, classNames: null } }],
    ["a theme with a non-string class name", { baseTheme: { name: "x", classNames: [null, 4, "ok"] } }],
  ];

  it.each(cases)("survives %s", (_label, appearance) => {
    expect(() => resolveAppearance(appearance as Appearance)).not.toThrow();
  });

  it("skips null layers and invalid entries but keeps the valid themes", () => {
    const resolved = resolveAppearanceLayers([null, { baseTheme: [dark, undefined] } as unknown as Appearance]);
    expect(resolved.themes).toEqual([dark]);
  });

  it("treats baseTheme: null as not set, so it does not replace an earlier layer's", () => {
    const resolved = resolveAppearanceLayers([{ baseTheme: dark }, { baseTheme: null } as unknown as Appearance]);
    expect(resolved.themes).toEqual([dark]);
  });

  it("ignores a string theme with a development warning", () => {
    const resolved = resolveAppearance({ baseTheme: "dark" as unknown as BaseTheme });
    expect(resolved.theme.name).toBe("default");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not the string "dark"'));
  });

  it("lets an empty baseTheme list reset to the default theme", () => {
    expect(resolveAppearanceLayers([{ baseTheme: dark }, { baseTheme: [] }]).themes.map((theme) => theme.name)).toEqual(["default"]);
  });
});

describe("element overrides", () => {
  it("call functions with no arguments and warn in development when one throws", () => {
    const fn = vi.fn(() => "from-fn");
    expect(flattenElement(fn).classNames).toEqual(["from-fn"]);
    expect(fn).toHaveBeenCalledWith();
    expect(
      flattenElement(() => {
        throw new Error("boom");
      }).classNames,
    ).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });

  it("let unstyled: false restore one element under a global unstyled", () => {
    const resolver = createElementResolver(resolveAppearance({ unstyled: true, elements: { formButtonPrimary: { unstyled: false } } }));
    expect(resolver(["button"]).unstyled).toBe(true);
    expect(resolver(["button", "buttonPrimary", "formButtonPrimary"]).unstyled).toBeUndefined();
  });

  it("let the most specific key decide", () => {
    const resolver = createElementResolver(resolveAppearance({ elements: { button: { unstyled: true }, formButtonPrimary: { unstyled: false } } }));
    expect(resolver(["button", "formButtonPrimary"]).unstyled).toBeUndefined();
    expect(resolver(["formButtonPrimary", "button"]).unstyled).toBe(true);
  });

  it("keep a light base theme free of inline variables", () => {
    expect(resolveAppearance({ baseTheme: light }).cssVariables).toEqual({});
  });
});

describe("scheme presets inside one theme array", () => {
  it("drop an earlier scheme preset's tokens when a later one changes the scheme", () => {
    const resolved = resolveAppearance({ baseTheme: [dark, light] });
    expect(resolved.cssVariables).toEqual({});
    const soft = { name: "brand", classNames: ["brand"], variables: { borderRadius: "2px" } };
    const mixed = resolveAppearance({ baseTheme: [dark, soft, light] });
    expect(mixed.cssVariables).toEqual({ "--radius": "2px", "--orbitid-border-radius": "2px" });
    // The last scheme preset still writes its own tokens.
    expect(resolveAppearance({ baseTheme: [light, dark] }).cssVariables["--card"]).toBe(dark.variables!.colorBackground);
  });

  it("merge same-scheme themes in order", () => {
    const myDark = { name: "brand", classNames: ["dark"], variables: { colorBackground: "#101014", borderRadius: "9px" } };
    const accent = { name: "accent", classNames: ["dark"], variables: { colorPrimary: "#00ff88" } };
    const stacked = resolveAppearance({ baseTheme: [myDark, accent] }).cssVariables;
    expect(stacked["--card"]).toBe("#101014");
    expect(stacked["--radius"]).toBe("9px");
    expect(stacked["--primary"]).toBe("#00ff88");
    // The built-in dark preset never sets a radius, so the earlier brand theme's radius survives it.
    expect(resolveAppearance({ baseTheme: [myDark, dark] }).cssVariables["--radius"]).toBe("9px");
  });

  it("tolerate non-string class names when picking the scheme", () => {
    const broken = { name: "x", classNames: [null, 3, "dark"] } as unknown as BaseTheme;
    expect(() => resolveAppearance({ baseTheme: broken })).not.toThrow();
  });
});

describe("undefined values", () => {
  it("do not erase an alias in the same layer or an earlier layer's value", () => {
    expect(cssVariablesFrom({ colorText: "#ff0000", colorForeground: undefined })["--foreground"]).toBe("#ff0000");
    const resolved = resolveAppearanceLayers([{ variables: { colorPrimary: "#ff0000" } }, { variables: { colorPrimary: undefined } }]);
    expect(resolved.cssVariables["--primary"]).toBe("#ff0000");
  });
});

describe("fontSize out of range", () => {
  it.each(["0px", "-2px", "0rem"])("warns about %s", (value) => {
    expect(cssVariablesFrom({ fontSize: value })["--font-scale"]).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("positive size"));
  });
});
