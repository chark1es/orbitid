import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ThemeProvider } from "@orbitid/ui";
import { ThemeToggle } from "./theme-toggle";

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
  localStorage.clear();
});

describe("theme toggle", () => {
  it("starts on system and stores an explicit dark choice", async () => {
    render(
      <ThemeProvider storageKey="orbitid-theme">
        <ThemeToggle />
      </ThemeProvider>,
    );

    const trigger = screen.getByRole("button", { name: "Theme: system" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.keyDown(trigger, { key: "Enter" });

    fireEvent.click(await screen.findByRole("menuitem", { name: "Dark" }));

    expect(localStorage.getItem("orbitid-theme")).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(screen.getByRole("button", { name: "Theme: dark" })).toBeTruthy();
  });
});
