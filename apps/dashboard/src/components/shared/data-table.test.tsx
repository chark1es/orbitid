import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { Button, Checkbox, TableCell } from "@orbitid/ui";
import { DataTable, stackedCell, type DataTableColumn } from "./data-table";
import { EmptyState } from "./empty-state";

interface Row {
  id: string;
  name: string;
  status: string;
}

const ROWS: Row[] = [{ id: "row_1", name: "Ada Lovelace", status: "Active" }];

const COLUMNS: DataTableColumn<Row>[] = [
  { id: "name", header: "User", cell: (row) => <span>{row.name}</span> },
  { id: "status", header: "Status", cell: (row) => <span>{row.status}</span> },
  {
    id: "actions",
    header: <span className="sr-only">Actions</span>,
    cell: () => (
      <Button type="button" size="sm" variant="outline">
        Inspect
      </Button>
    ),
  },
];

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
  // matchMedia is restored by each narrow test.
});

describe("DataTable", () => {
  it("keeps the real table from sm up", () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.id} />);
    expect(screen.getByRole("table")).toBeTruthy();
    expect(document.querySelector('[data-slot="data-table-stack"]')).toBeNull();
  });

  it("stacks labelled fields and keeps actions visible at 375px", () => {
    const restore = withNarrowViewport();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.id} />);
      expect(screen.queryByRole("table")).toBeNull();
      const stack = document.querySelector('[data-slot="data-table-stack"]');
      expect(stack).toBeTruthy();
      // Stacked rows are not a table: no <td> and no table-cell reset selectors.
      expect(stack?.className).not.toContain("[&_td]");
      expect(stack?.querySelector("td")).toBeNull();
      expect(stack?.textContent).toContain("Ada Lovelace");
      expect(stack?.textContent).toContain("Status");
      expect(stack?.textContent).toContain("Active");
      expect(screen.getByRole("button", { name: "Inspect" })).toBeTruthy();
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
      restore();
    }
  });

  it("unwraps a page-supplied table cell into a plain div", () => {
    render(
      <div>
        {stackedCell(
          <TableCell className="max-w-[12rem]">
            <span>Ada Lovelace</span>
          </TableCell>,
        )}
      </div>,
    );
    // A <td> inside <div>/<dd> is invalid HTML (and a React warning); keep the sizing in a div.
    expect(document.querySelector("td")).toBeNull();
    const text = screen.getByText("Ada Lovelace");
    expect(text.parentElement?.tagName).toBe("DIV");
    expect(text.parentElement?.className).toContain("max-w-[12rem]");
  });

  it("keeps table-only columns as labelled fields in the stacked layout", () => {
    const restore = withNarrowViewport();
    try {
      render(
        <DataTable
          columns={[
            ...COLUMNS.slice(0, 2),
            {
              id: "ip",
              header: "IP address",
              headerClassName: "hidden md:table-cell",
              className: "hidden md:table-cell",
              cell: (row) => <span>{row.id}</span>,
            },
          ]}
          rows={ROWS}
          rowKey={(row) => row.id}
        />,
      );
      const stack = document.querySelector('[data-slot="data-table-stack"]');
      // The table-only class must not make the field disappear from a stacked card.
      expect(stack?.textContent).toContain("IP address");
      expect(stack?.textContent).toContain("row_1");
    } finally {
      restore();
    }
  });

  it("exposes select-all and sort controls above the stacked rows", () => {
    const restore = withNarrowViewport();
    const onSort = vi.fn();
    const onSelectAll = vi.fn();
    try {
      render(
        <DataTable
          columns={[
            {
              id: "select",
              header: <Checkbox aria-label="Select all rows" onCheckedChange={onSelectAll} />,
              cell: (row) => <Checkbox aria-label={`Select ${row.name}`} />,
            },
            { id: "name", header: "User", cell: (row) => <span>{row.name}</span> },
            { id: "username", header: "Username", sortKey: "username", cell: (row) => <span>{row.status}</span> },
          ]}
          rows={ROWS}
          rowKey={(row) => row.id}
          sortKey="username"
          sortDescending={false}
          onSort={onSort}
        />,
      );

      // A group of buttons, not a table row: there is no table ancestor for row/columnheader here.
      const group = screen.getByRole("group", { name: "Sort columns" });
      expect(group.querySelector('[role="columnheader"]')).toBeNull();
      expect(screen.queryByRole("row")).toBeNull();

      const sortControl = within(group).getByRole("button", { name: "Sort by Username, sorted ascending" });
      expect(sortControl.getAttribute("aria-pressed")).toBe("true");
      expect(sortControl.getAttribute("aria-sort")).toBeNull();

      fireEvent.click(sortControl);
      expect(onSort).toHaveBeenCalledWith("username");

      const checkbox = screen.getByRole("checkbox", { name: "Select all rows" });
      expect(checkbox.closest("label")?.textContent).toContain("Select all");
      fireEvent.click(checkbox);
      expect(onSelectAll).toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("renders the empty state inside the stacked frame", () => {
    const restore = withNarrowViewport();
    try {
      render(
        <DataTable
          columns={COLUMNS}
          rows={[]}
          rowKey={(row) => row.id}
          empty={<p>No users yet</p>}
        />,
      );
      expect(screen.getByText("No users yet")).toBeTruthy();
    } finally {
      restore();
    }
  });

  it("lets a long token break inside the stacked row instead of widening the page", () => {
    const restore = withNarrowViewport();
    try {
      const longToken = `operator_session.created_${"a".repeat(160)}`;
      render(
        <DataTable
          columns={[
            { id: "action", header: "Action", cell: () => <code>{longToken}</code> },
            { id: "actor", header: "Actor", cell: () => <span>{longToken}</span> },
          ]}
          rows={ROWS}
          rowKey={(row) => row.id}
        />,
      );
      const stack = document.querySelector('[data-slot="data-table-stack"]')!;
      const primary = screen.getByText(longToken, { selector: "code" });
      expect(primary.closest(".break-words")).toBeTruthy();
      const field = screen.getByText(longToken, { selector: "span" }).closest("dd")!;
      expect(field.className).toContain("break-words");
      expect(field.className).toContain("min-w-0");
      expect(field.className).toContain("overflow-hidden");
      // Monospace ids are a single token: break them anywhere inside the value cell.
      expect(field.className).toContain("[&_.font-data]:break-all");
      expect(stack.querySelectorAll("td")).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("keeps a 200-character field value inside every stacked card box", () => {
    const restore = withNarrowViewport();
    try {
      const longValue = "x".repeat(200);
      render(
        <DataTable
          columns={[
            { id: "event", header: "Event", cell: () => <span>Signed in</span> },
            { id: "detail", header: "Detail", cell: () => <span>{longValue}</span> },
          ]}
          rows={ROWS}
          rowKey={(row) => row.id}
        />,
      );
      const stack = document.querySelector('[data-slot="data-table-stack"]')!;
      const dd = screen.getByText(longValue).closest("dd")!;
      const dl = dd.closest("dl")!;
      const card = dd.closest("li")!;
      expect(dd.className).toContain("min-w-0");
      // An implicit `auto` grid column is sized by its content, so the long value would widen the card.
      expect(dl.className).toContain("grid-cols-[minmax(0,1fr)]");
      // jsdom has no layout engine: walk the boxes the value passes through instead. Every ancestor up to
      // and including the card must be shrinkable, or a 200-character value clips its right edge at 375px.
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
      expect(stack.parentElement?.className).toContain("overflow-hidden");
    } finally {
      restore();
    }
  });

  it("uses the compact empty state inside a table but a full one on a page", () => {
    const view = render(
      <DataTable columns={COLUMNS} rows={[]} rowKey={(row) => row.id} empty={<EmptyState title="No users yet" />} />,
    );
    expect(screen.getByText("No users yet").closest("[data-variant]")?.getAttribute("data-variant")).toBe("compact");
    view.unmount();

    // The same component keeps the full measure when it stands in for a whole page.
    render(<EmptyState title="No users yet" />);
    expect(screen.getByText("No users yet").closest("[data-variant]")?.getAttribute("data-variant")).toBe("full");
  });
});
