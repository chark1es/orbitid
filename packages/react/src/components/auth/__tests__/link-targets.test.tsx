import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { screen } from "@testing-library/react";
import { FooterSwitch, LinkButton } from "../sign-in/steps/shared";
import { renderAuth, setupAuth } from "./fake-auth";

function expectLinkTarget(button: HTMLElement) {
  // WCAG 2.5.8 asks for 24x24 CSS pixels. `h-auto p-0` shrank the hit box to the 13-14px text line.
  expect(button.className).toContain("min-h-6");
  expect(button.className).toContain("py-1");
  expect(button.className).not.toContain("h-auto p-0");
}

function tsxFiles(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) return entry === "__tests__" ? [] : tsxFiles(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

describe("inline link buttons", () => {
  it("keeps the sign-in footer action at the 24px minimum", () => {
    renderAuth(
      <FooterSwitch text="No account?" actionLabel="Sign up" onClick={() => {}} />,
      setupAuth({ signedIn: false }),
    );
    expectLinkTarget(screen.getByRole("button", { name: "Sign up" }));
  });

  it("keeps the 'use another method' link at the 24px minimum", () => {
    renderAuth(<LinkButton label="Use another method" onClick={() => {}} />, setupAuth({ signedIn: false }));
    expectLinkTarget(screen.getByRole("button", { name: "Use another method" }));
  });

  it("leaves no link-style button with the old h-auto p-0 target", () => {
    const root = resolve(process.cwd(), "src/components");
    const offenders = tsxFiles(root).filter((file) => readFileSync(file, "utf8").includes("h-auto p-0"));
    expect(offenders).toEqual([]);
  });
});
