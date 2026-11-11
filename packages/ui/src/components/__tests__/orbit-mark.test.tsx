import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { OrbitMark } from "../orbit-mark";

describe("OrbitMark", () => {
  it("draws the one ring-and-dot mark in currentColor", () => {
    const { container } = render(<OrbitMark />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 32 32");
    const circle = svg?.querySelector("circle");
    expect(circle?.getAttribute("stroke")).toBe("currentColor");
    expect(svg?.querySelectorAll("circle")).toHaveLength(2);
  });

  it("names itself only when a title is supplied", () => {
    const { rerender } = render(<OrbitMark />);
    expect(screen.queryByRole("img")).toBeNull();
    rerender(<OrbitMark title="OrbitID" />);
    expect(screen.getByRole("img", { name: "OrbitID" })).toBeTruthy();
  });
});
