import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Button, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@orbitid/ui";
import { RuledTable } from "../ui/data";

function withNarrowViewport() {
  const original = window.matchMedia;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query.includes("639px"),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
  return () => Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: original });
}

afterEach(() => {
  // Each narrow test restores matchMedia itself.
});

describe("RuledTable", () => {
  it("stays a real table from 640px up", () => {
    render(
      <RuledTable>
        <TableHeader>
          <TableRow>
            <TableHead>Endpoint</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>https://example.com/hooks</TableCell>
            <TableCell>Active</TableCell>
            <TableCell>
              <Button size="sm">Delete</Button>
            </TableCell>
          </TableRow>
        </TableBody>
      </RuledTable>,
    );

    expect(screen.getByRole("table")).toBeTruthy();
    expect(document.querySelector('[data-slot="ruled-table-stack"]')).toBeNull();
  });

  it("stacks labelled rows and keeps the action visible at 375px", () => {
    const restore = withNarrowViewport();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(
        <RuledTable>
          <TableHeader>
            <TableRow>
              <TableHead>Endpoint</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell className="max-w-[26rem]">https://example.com/hooks</TableCell>
              <TableCell>Active</TableCell>
              <TableCell>
                <Button size="sm">Delete</Button>
              </TableCell>
            </TableRow>
          </TableBody>
        </RuledTable>,
      );

      expect(screen.queryByRole("table")).toBeNull();
      const stack = document.querySelector('[data-slot="ruled-table-stack"]');
      expect(stack).toBeTruthy();
      // A stacked row is not a table: no <td> survives, so React has nothing to warn about.
      expect(stack?.querySelector("td")).toBeNull();
      expect(stack?.innerHTML).toContain("max-w-[26rem]");
      const list = stack?.querySelector("ul");
      expect(list?.className).not.toContain("[&_td]");
      expect(stack?.querySelector("dd")?.className).toContain("[&_span]:align-baseline");
      expect(stack?.textContent).toContain("https://example.com/hooks");
      expect(stack?.textContent).toContain("Status");
      expect(stack?.textContent).toContain("Active");
      expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
      restore();
    }
  });

  it("keeps a 200-character field value inside every stacked card box", () => {
    const restore = withNarrowViewport();
    try {
      const longValue = "y".repeat(200);
      render(
        <RuledTable>
          <TableHeader>
            <TableRow>
              <TableHead>Endpoint</TableHead>
              <TableHead>Detail</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>https://example.com/hooks</TableCell>
              <TableCell>
                <span>{longValue}</span>
              </TableCell>
            </TableRow>
          </TableBody>
        </RuledTable>,
      );

      const stack = document.querySelector('[data-slot="ruled-table-stack"]')!;
      const dd = screen.getByText(longValue).closest("dd")!;
      const dl = dd.closest("dl")!;
      const card = dd.closest("li")!;
      expect(dd.className).toContain("min-w-0");
      expect(dl.className).toContain("grid-cols-[minmax(0,1fr)]");
      let node: HTMLElement | null = dd;
      while (node) {
        const constrained =
          node.className.includes("min-w-0") ||
          (node.tagName === "DL" && node.className.includes("grid-cols-[minmax(0,1fr)]"));
        expect(constrained, `${node.tagName} carries a shrink constraint: ${node.className}`).toBe(true);
        if (node === card) break;
        node = node.parentElement;
      }
      expect(node).toBe(card);
    } finally {
      restore();
    }
  });

  it("renders a colSpan row full width in the stacked layout", () => {
    const restore = withNarrowViewport();
    try {
      render(
        <RuledTable>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell colSpan={3}>No rows yet</TableCell>
            </TableRow>
          </TableBody>
        </RuledTable>,
      );
      expect(screen.getByText("No rows yet")).toBeTruthy();
    } finally {
      restore();
    }
  });
});
