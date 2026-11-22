import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { OrbitMark } from "../orbit-mark";

describe("OrbitMark", () => {
  it("draws the open orbit, satellite and core in currentColor", () => {
    const { container } = render(<OrbitMark />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 32 32");
    expect(svg?.querySelector('[data-part="orbit"]')?.getAttribute("stroke")).toBe("currentColor");
    expect(svg?.querySelector('[data-part="satellite"]')?.getAttribute("fill")).toBe("currentColor");
    expect(svg?.querySelector('[data-part="core"]')?.getAttribute("fill")).toBe("currentColor");
  });

  it("recolours only the core when an accent is given", () => {
    const { container } = render(<OrbitMark accent="var(--signal)" />);
    expect(container.querySelector('[data-part="core"]')?.getAttribute("fill")).toBe("var(--signal)");
    expect(container.querySelector('[data-part="orbit"]')?.getAttribute("stroke")).toBe("currentColor");
  });

  it("names itself only when a title is supplied", () => {
    const { rerender } = render(<OrbitMark />);
    expect(screen.queryByRole("img")).toBeNull();
    rerender(<OrbitMark title="OrbitID" />);
    expect(screen.getByRole("img", { name: "OrbitID" })).toBeTruthy();
  });
});
