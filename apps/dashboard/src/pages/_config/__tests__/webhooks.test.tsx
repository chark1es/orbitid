import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useApi } from "../../../lib/api";
import Page from "../../webhooks";

vi.mock("../../../lib/api", () => ({
  api: vi.fn(),
  getApiUrl: () => "http://localhost:4000",
  useApi: vi.fn(),
}));

const endpoint = {
  id: "we_1",
  url: "https://example.com/hooks",
  description: "Production receiver",
  event_types: [],
  disabled: false,
  created_at: 1_700_000_000_000,
};

const delivery = {
  id: "whd_1",
  event_type: "user.created",
  status: "failed",
  attempt: 2,
  response_code: 500,
  response_body: "upstream error",
  created_at: 1_700_000_100_000,
};

describe("webhooks page", () => {
  it("keeps the status switch and badge on the label's baseline", () => {
    vi.mocked(useApi).mockImplementation((_key, path) => {
      if (String(path).includes("deliveries")) {
        return { data: { data: [delivery], total_count: 1 }, isLoading: false, error: null, refetch: vi.fn(), isFetching: false } as never;
      }
      return { data: { data: [endpoint], total_count: 1 }, isLoading: false, error: null, refetch: vi.fn(), isFetching: false } as never;
    });

    render(<Page />);
    const badge = screen.getByText("Active");
    // Stacked rows are items-baseline; the switch must opt back into centring inside that row.
    expect(badge.parentElement?.className).toContain("items-baseline");
    expect(screen.getByRole("switch", { name: "Endpoint enabled" }).className).toContain("self-center");
  });

  it("hides low-priority columns below xl so the table fits at 768 and 1024", () => {
    vi.mocked(useApi).mockImplementation((_key, path) => {
      if (String(path).includes("deliveries")) {
        return { data: { data: [], total_count: 0 }, isLoading: false, error: null, refetch: vi.fn(), isFetching: false } as never;
      }
      return { data: { data: [endpoint], total_count: 1 }, isLoading: false, error: null, refetch: vi.fn(), isFetching: false } as never;
    });

    render(<Page />);
    for (const name of ["Events", "Created"]) {
      const head = screen.getByRole("columnheader", { name });
      expect(head.className).toContain("hidden");
      expect(head.className).toContain("xl:table-cell");
    }
    expect(screen.getByRole("columnheader", { name: "Endpoint" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Status" })).toBeTruthy();
  });

  it("does not show a validation list until the endpoint form is submitted", () => {
    vi.mocked(useApi).mockImplementation((_key, path) => {
      if (String(path).includes("deliveries")) {
        return { data: { data: [], total_count: 0 }, isLoading: false, error: null, refetch: vi.fn(), isFetching: false } as never;
      }
      return { data: { data: [], total_count: 0 }, isLoading: false, error: null, refetch: vi.fn(), isFetching: false } as never;
    });

    render(<Page />);
    fireEvent.click(screen.getAllByRole("button", { name: /Add endpoint/ })[0]!);
    const sheet = screen.getByRole("dialog");
    expect(within(sheet).queryByText("Fix this before saving")).toBeNull();
    fireEvent.click(within(sheet).getByRole("button", { name: "Add endpoint" }));
    expect(within(sheet).getByText("Fix this before saving")).toBeTruthy();
    expect(within(sheet).getByText("Endpoint URL is required.")).toBeTruthy();
    expect(within(sheet).queryByText(/must be an http/)).toBeNull();
  });

  it("opens delivery details in a right-side sheet with time, status, attempt, and response", () => {
    vi.mocked(useApi).mockImplementation((_key, path) => {
      if (String(path).includes("deliveries")) {
        return { data: { data: [delivery], total_count: 1 }, isLoading: false, error: null, refetch: vi.fn(), isFetching: false } as never;
      }
      return { data: { data: [endpoint], total_count: 1 }, isLoading: false, error: null, refetch: vi.fn(), isFetching: false } as never;
    });

    render(<Page />);
    expect(screen.getByText("https://example.com/hooks")).toBeTruthy();

    fireEvent.click(screen.getByTitle("Deliveries"));

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Delivery log")).toBeTruthy();
    expect(screen.getByText("Time")).toBeTruthy();
    expect(screen.getByText("Attempt")).toBeTruthy();
    expect(screen.getByText("user.created")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText(/500/)).toBeTruthy();
  });
});
