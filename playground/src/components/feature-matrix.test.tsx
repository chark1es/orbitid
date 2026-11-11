// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { FeatureMatrix } from "./feature-matrix";
import type { FeatureSection } from "@/lib/feature-matrix";

afterEach(cleanup);

const SECTION: FeatureSection = {
  id: "sign-in",
  title: "Sign-in",
  rows: [
    {
      id: "password",
      label: "Password",
      status: "enabled",
      value: "On",
      tryHref: "/sign-in",
    },
  ],
};

describe("FeatureMatrix", () => {
  it("only scrolls sideways from sm up; the card layout below sm never overflows", () => {
    render(<FeatureMatrix sections={[SECTION]} />);
    const table = screen.getByRole("table");
    const scroller = table.parentElement!;
    // The matrix is wider than the phone until 640px; below sm it is a stack of labelled cards.
    expect(scroller.className).toContain("sm:overflow-x-auto");
    expect(scroller.className).not.toMatch(/(^|\s)overflow-x-auto(\s|$)/);
    expect(scroller.className).toContain("min-w-0");
  });

  it("labels status and detail on each narrow card", () => {
    render(<FeatureMatrix sections={[SECTION]} />);
    // The desktop header also says Status and Detail; only the card labels are narrow-only.
    const statusLabels = screen.getAllByText("Status").filter((node) => node.className.includes("sm:hidden"));
    const detailLabels = screen.getAllByText("Detail").filter((node) => node.className.includes("sm:hidden"));
    expect(statusLabels).toHaveLength(1);
    expect(detailLabels).toHaveLength(1);
  });

  it("breaks a long detail value instead of widening the page at 375", () => {
    render(
      <FeatureMatrix
        sections={[
          {
            ...SECTION,
            rows: [
              {
                ...SECTION.rows[0]!,
                value: `NEXT_PUBLIC_ORBITID_PUBLISHABLE_KEY=${"x".repeat(120)}`,
              },
            ],
          },
        ]}
      />,
    );
    const value = screen.getByText(/NEXT_PUBLIC_ORBITID_PUBLISHABLE_KEY/);
    expect(value.className).toContain("break-words");
    expect(value.className).toContain("[overflow-wrap:anywhere]");
  });
});
