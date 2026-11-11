import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { SidebarMenuButton, SidebarProvider } from "../ui/sidebar";
import { badgeVariants } from "../ui/badge";
import { buttonVariants } from "../ui/button";
import { Avatar, AvatarFallback } from "../ui/avatar";
import { CONTROL_RECIPE } from "../../lib/control";

const RECIPE_TOKENS = ["items-center", "justify-center", "leading-none", "control-optical"];

function expectRecipe(className: string) {
  for (const token of RECIPE_TOKENS) expect(className, `${token} in ${className}`).toContain(token);
  expect(className).not.toContain("translate-y");
}

describe("shared control recipe", () => {
  it.each(["default", "destructive", "outline", "secondary", "ghost", "link"] as const)(
    "centres every %s button label and icon",
    (variant) => {
      expectRecipe(buttonVariants({ variant }));
    },
  );

  it.each(["default", "xs", "sm", "lg", "icon", "icon-xs", "icon-sm", "icon-lg"] as const)(
    "centres the %s button size",
    (size) => {
      expectRecipe(buttonVariants({ size }));
    },
  );

  it("exports the recipe so every new control can reuse it", () => {
    expectRecipe(CONTROL_RECIPE);
  });

  it("centres a chip's word and dot", () => {
    expectRecipe(badgeVariants());
  });

  it("centres avatar initials without a baseline nudge", () => {
    render(
      <Avatar>
        <AvatarFallback>AL</AvatarFallback>
      </Avatar>,
    );
    expectRecipe(screen.getByText("AL").className);
  });

  it("centres icon-only buttons", () => {
    render(
      <button type="button" className={buttonVariants({ size: "icon" })}>
        <span data-testid="glyph">+</span>
      </button>,
    );
    expectRecipe(screen.getByRole("button").className);
  });

  it("keeps the rail item's hover and active utilities separated", () => {
    render(
      <SidebarProvider>
        <SidebarMenuButton>Overview</SidebarMenuButton>
      </SidebarProvider>,
    );
    const className = screen.getByRole("button", { name: "Overview" }).className;
    expect(className).toContain("hover:text-sidebar-accent-foreground");
    expect(className).toContain("active:bg-sidebar-accent");
    expect(className).not.toContain("foregroundactive:");
  });

  it("removes the hand-tuned checkbox offset from table cells", async () => {    const { TableCell, TableHead } = await import("../ui/table");
    render(
      <table>
        <thead>
          <tr>
            <TableHead>Select</TableHead>
          </tr>
        </thead>
        <tbody>
          <tr>
            <TableCell>Row</TableCell>
          </tr>
        </tbody>
      </table>,
    );
    expect(screen.getByText("Select").className).not.toContain("translate-y");
    expect(screen.getByText("Row").className).not.toContain("translate-y");
  });

  it("declares one optical rule and one icon stroke weight in the stylesheet", () => {
    const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    expect(css).toContain("@utility control-optical");
    expect(css).toMatch(/svg\.lucide\s*\{\s*stroke-width:\s*1\.5;/);
    expect(css).toContain("--font-weight-heading: 650");
  });
});
