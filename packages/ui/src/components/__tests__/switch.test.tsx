import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Switch } from "../ui/switch";

/** The spacing scale as pixels, for the utilities the switch is allowed to use. */
const PX: Record<string, number> = {
  border: 1,
  "p-px": 1,
  "p-0.5": 2,
  "h-5": 20,
  "w-9": 36,
  "h-4": 16,
  "w-7": 28,
  "size-4": 16,
  "size-3": 12,
  "translate-x-4": 16,
  "translate-x-3": 12,
  "translate-x-3.5": 14,
};

function tokens(className: string): string[] {
  return className.split(/\s+/).filter(Boolean);
}

function utility(token: string): string {
  return token.slice(token.lastIndexOf(":") + 1);
}

function value(className: string, pattern: RegExp, label: string): number {
  const token = tokens(className).find((candidate) => pattern.test(candidate));
  expect(token, `${label} (${pattern}) in ${className}`).toBeTruthy();
  const px = PX[utility(token!)];
  expect(px, `known pixel value for ${token} in ${className}`).toBeTypeOf("number");
  return px;
}

/** A signed translate: RTL flips the sign, so read it rather than dropping the token. */
function translate(className: string, pattern: RegExp, label: string): number {
  const token = tokens(className).find((candidate) => pattern.test(candidate));
  expect(token, `${label} (${pattern}) in ${className}`).toBeTruthy();
  const name = utility(token!);
  const negative = name.startsWith("-");
  const px = PX[negative ? name.slice(1) : name];
  expect(px, `known pixel value for ${token} in ${className}`).toBeTypeOf("number");
  return negative ? -px : px;
}

function renderSwitch(size?: "sm" | "default") {
  render(<Switch aria-label={`Toggle ${size ?? "default"}`} checked size={size} />);
  const root = document.querySelector('[data-slot="switch"]');
  const thumb = document.querySelector('[data-slot="switch-thumb"]');
  expect(root).toBeTruthy();
  expect(thumb).toBeTruthy();
  return { root: root as HTMLElement, thumb: thumb as HTMLElement };
}

describe("Switch geometry", () => {
  it("keeps the default thumb concentric and travels exactly the inner width", () => {
    const { root, thumb } = renderSwitch();
    const trackClass = root.className;
    const thumbClass = thumb.className;

    const border = value(trackClass, /^border$/, "default border");
    const padding = value(trackClass, /^p-px$/, "default padding");
    const width = value(trackClass, /data-\[size=default\]:w-9$/, "default width");
    const height = value(trackClass, /data-\[size=default\]:h-5$/, "default height");
    const thumbSize = value(thumbClass, /group-data-\[size=default\]\/switch:size-4$/, "default thumb");
    const travel = translate(thumbClass, /^data-\[state=checked\]:translate-x-4$/, "default travel");

    // 2px inside every edge: 20 - 2 - 2 - 16 = 0 at rest, 36 - 2 - 2 - 16 = 16 of travel.
    expect(height - 2 * border - 2 * padding).toBe(thumbSize);
    expect(width - 2 * border - 2 * padding - thumbSize).toBe(travel);
  });

  it("keeps the sm thumb concentric and travels exactly its inner width", () => {
    const { root, thumb } = renderSwitch("sm");
    const trackClass = root.className;
    const thumbClass = thumb.className;

    const border = value(trackClass, /^border$/, "sm border");
    const padding = value(trackClass, /^p-px$/, "sm padding");
    const width = value(trackClass, /data-\[size=sm\]:w-7$/, "sm width");
    const height = value(trackClass, /data-\[size=sm\]:h-4$/, "sm height");
    const thumbSize = value(thumbClass, /group-data-\[size=sm\]\/switch:size-3$/, "sm thumb");
    const travel = translate(
      thumbClass,
      /^group-data-\[size=sm\]\/switch:data-\[state=checked\]:translate-x-3$/,
      "sm travel",
    );

    expect(height - 2 * border - 2 * padding).toBe(thumbSize);
    expect(width - 2 * border - 2 * padding - thumbSize).toBe(travel);
  });

  it("mirrors the travel in right-to-left layouts", () => {
    const { thumb } = renderSwitch();
    const thumbClass = thumb.className;
    expect(translate(thumbClass, /^rtl:data-\[state=checked\]:-translate-x-4$/, "default RTL travel")).toBe(-16);
    expect(
      translate(
        thumbClass,
        /^group-data-\[size=sm\]\/switch:rtl:data-\[state=checked\]:-translate-x-3$/,
        "sm RTL travel",
      ),
    ).toBe(-12);
  });
});
