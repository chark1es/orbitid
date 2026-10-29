import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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
    expect(screen.getByText("failed")).toBeTruthy();
    expect(screen.getByText(/500/)).toBeTruthy();
  });
});
