import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Page } from "./page";

describe("page rhythm", () => {
  it("puts every direct block 24px below the one before it", () => {
    const { container } = render(
      <Page>
        <h1>Title</h1>
        <p>Content</p>
      </Page>,
    );
    const wrapper = container.querySelector('[data-slot="page"]') as HTMLElement;
    // One rhythm: title row to first content, and section to section, are both 24px (gap-6).
    expect(wrapper.className).toContain("flex");
    expect(wrapper.className).toContain("flex-col");
    expect(wrapper.className).toContain("gap-6");
  });
});
