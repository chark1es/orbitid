import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { PageHeader } from "./page-header";

describe("PageHeader rhythm", () => {
  it("leaves 12px under the rule so title-to-content lands near 28px, not 40", () => {
    const { container } = render(<PageHeader title="Users" description="All accounts." />);
    const header = container.firstElementChild as HTMLElement;
    expect(header.className).toContain("pb-3");
    expect(header.className).not.toContain("pb-4");
    expect(header.className).toContain("border-b");
  });
});
