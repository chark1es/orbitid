import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { useTableState } from "./use-table-state";

function Probe() {
  const table = useTableState({ limit: 20, orderBy: "-created_at", filterKeys: ["status"] });
  const location = useLocation();
  return createElement(
    "div",
    null,
    createElement("output", { "data-testid": "search" }, location.search),
    createElement(
      "output",
      { "data-testid": "state" },
      JSON.stringify({
        page: table.page,
        limit: table.limit,
        query: table.query,
        orderBy: table.orderBy,
        status: table.filter("status"),
        hasFilters: table.hasFilters,
      }),
    ),
    createElement("button", { type: "button", onClick: () => table.toggleSort("name") }, "sort-name"),
    createElement("button", { type: "button", onClick: () => table.setPage(3) }, "page-3"),
    createElement("button", { type: "button", onClick: () => table.setLimit(50) }, "limit-50"),
    createElement("button", { type: "button", onClick: () => table.setQuery("  ada  ") }, "search"),
    createElement("button", { type: "button", onClick: () => table.setFilter("status", "active") }, "filter"),
    createElement("button", { type: "button", onClick: () => table.reset() }, "reset"),
  );
}

function renderProbe(initial = "/sessions") {
  return render(createElement(MemoryRouter, { initialEntries: [initial] }, createElement(Probe)));
}

const search = () => screen.getByTestId("search").textContent ?? "";
const state = () => JSON.parse(screen.getByTestId("state").textContent ?? "{}");

describe("useTableState", () => {
  it("reads defaults without writing them into the URL", () => {
    renderProbe();
    expect(search()).toBe("");
    expect(state()).toMatchObject({ page: 1, limit: 20, orderBy: "-created_at", hasFilters: false });
  });

  it("toggles a sort ascending, then descending, and drops the page", () => {
    renderProbe("/sessions?page=2");
    fireEvent.click(screen.getByRole("button", { name: "sort-name" }));

    expect(search()).toContain("order_by=name");
    expect(search()).not.toContain("page=");
    expect(state().orderBy).toBe("name");

    fireEvent.click(screen.getByRole("button", { name: "sort-name" }));
    expect(search()).toContain("order_by=-name");
    expect(state().orderBy).toBe("-name");
  });

  it("sets page and limit, trims the search and records filters", () => {
    renderProbe();
    fireEvent.click(screen.getByRole("button", { name: "page-3" }));
    expect(search()).toContain("page=3");
    expect(state().page).toBe(3);

    fireEvent.click(screen.getByRole("button", { name: "limit-50" }));
    expect(search()).toContain("limit=50");
    expect(search()).not.toContain("page=");
    expect(state().limit).toBe(50);

    fireEvent.click(screen.getByRole("button", { name: "search" }));
    expect(search()).toContain("query=ada");
    expect(state().query).toBe("ada");

    fireEvent.click(screen.getByRole("button", { name: "filter" }));
    expect(search()).toContain("status=active");
    expect(state().hasFilters).toBe(true);
  });

  it("resets filters and paging, keeping only a non-default limit and the default order", () => {
    renderProbe("/sessions?page=2&query=ada&status=active&limit=50&order_by=name");
    fireEvent.click(screen.getByRole("button", { name: "reset" }));

    expect(search()).toBe("?limit=50&order_by=-created_at");
    expect(state()).toMatchObject({ page: 1, query: "", orderBy: "-created_at", status: "", hasFilters: false });
  });
});
