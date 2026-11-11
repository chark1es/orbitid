// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SetupRequired } from "./setup-required";

afterEach(cleanup);

describe("SetupRequired", () => {
  it("keeps the configuration state in one compact panel", () => {
    const { container } = render(
      <SetupRequired
        title="No instance connected"
        description="The test site reads the instance from the publishable key."
        missing="NEXT_PUBLIC_ORBITID_PUBLISHABLE_KEY is not set"
      />,
    );
    expect(container.querySelectorAll("section")).toHaveLength(1);
    expect(screen.getByText("What to set")).toBeTruthy();
    expect(screen.getByText("Run from the repository root")).toBeTruthy();
  });

  it("offers a break after every underscore instead of splitting a word mid-token", () => {
    const { container } = render(
      <SetupRequired
        title="No instance connected"
        description="Connect an instance."
        missing="NEXT_PUBLIC_ORBITID_PUBLISHABLE_KEY is not set"
      />,
    );
    const missingBlock = container.querySelector("section p.text-signal")!;
    expect(missingBlock.querySelectorAll("wbr").length).toBeGreaterThanOrEqual(4);
    const code = missingBlock.querySelector("code")!;
    expect(code.className).toContain("[overflow-wrap:anywhere]");
    expect(missingBlock.textContent).toBe("NEXT_PUBLIC_ORBITID_PUBLISHABLE_KEY is not set");
  });

  it("breaks the long env names in the what-to-set list the same way", () => {
    render(<SetupRequired title="No instance" description="Set the keys." />);
    const list = screen.getByText("What to set").parentElement!;
    expect(list.querySelectorAll("wbr").length).toBeGreaterThanOrEqual(5);
    const codes = list.querySelectorAll("dt code");
    expect(codes.length).toBeGreaterThanOrEqual(4);
    for (const code of codes) {
      expect(code.className).toContain("[overflow-wrap:anywhere]");
    }
  });
});
