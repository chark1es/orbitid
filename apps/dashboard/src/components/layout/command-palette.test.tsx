import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { CommandPalette } from "./command-palette";
import { mockApi, renderPage } from "../../pages/_config/__tests__/harness";

describe("command palette", () => {
  it("collapses to an icon below lg so the breadcrumb keeps its column", async () => {
    mockApi();
    renderPage(<CommandPalette />);

    const trigger = await screen.findByRole("button", { name: "Search pages and users" });
    expect(trigger.className).toContain("w-7");
    expect(trigger.className).toContain("lg:w-52");
    expect(trigger.className).not.toContain("sm:w-52");
    expect(trigger.textContent).toContain("Search");
    // The word and the shortcut leave the bar below 1024px; the accessible name keeps them discoverable.
    const label = [...trigger.querySelectorAll("span")].find((span) => span.textContent === "Search")!;
    expect(label.className).toContain("hidden");
    expect(label.className).toContain("lg:inline");
    const kbd = trigger.querySelector("kbd")!;
    expect(kbd.className).toContain("hidden");
    expect(kbd.className).toContain("lg:inline-flex");
  });

  it("opens at the 576px sheet width, not the 512px dialog default", async () => {
    mockApi();
    renderPage(<CommandPalette />);

    fireEvent.click(await screen.findByRole("button", { name: "Search pages and users" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.className).toContain("sm:max-w-xl");
    expect(dialog.className).not.toContain("sm:max-w-lg");
  });
});
