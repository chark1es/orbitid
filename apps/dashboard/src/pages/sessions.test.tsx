import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { SessionJSON } from "@orbitid/shared";
import SessionsPage from "./sessions";
import { mockApi, pendingApi, renderPage } from "./_config/__tests__/harness";

const SESSION = {
  id: "sess_1",
  status: "active",
  public_user_data: { user_id: "user_1", identifier: "ada@example.com", first_name: "Ada", last_name: "Lovelace" },
  created_at: 1_700_000_000_000,
  last_active_at: 1_700_000_100_000,
  expire_at: 1_700_100_000_000,
  latest_activity: { ip_address: "203.0.113.7", browser_name: "Firefox" },
} as unknown as SessionJSON;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("sessions page", () => {
  it("shows a loading state before the first page arrives", () => {
    pendingApi();
    renderPage(<SessionsPage />);
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy();
  });

  it("renders the empty state", async () => {
    mockApi();
    renderPage(<SessionsPage />);
    expect(await screen.findByText("No sessions yet")).toBeTruthy();
    expect(screen.getByText("No sessions yet").closest("[data-variant]")?.getAttribute("data-variant")).toBe("compact");
  });

  it("renders a populated page with its real total", async () => {
    mockApi({
      handle: (call) =>
        call.url.includes("/v1/sessions")
          ? json({ data: [SESSION], total_count: 31 })
          : undefined,
    });
    renderPage(<SessionsPage />);

    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
    expect(screen.getByText("203.0.113.7")).toBeTruthy();
    expect(screen.getByText("Showing 1–20 of 31")).toBeTruthy();
  });

  it("reports a list error and retries", async () => {
    let attempts = 0;
    mockApi({
      handle: (call) => {
        if (!call.url.includes("/v1/sessions")) return undefined;
        attempts += 1;
        return attempts === 1 ? json({ errors: [{ long_message: "Database unavailable" }] }, 500) : json({ data: [], total_count: 0 });
      },
    });
    renderPage(<SessionsPage />);

    expect(await screen.findByText(/Database unavailable/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No sessions yet")).toBeTruthy();
  });

  it("revokes a session only after the confirm dialog", async () => {
    const calls = mockApi({
      handle: (call) => (call.url.includes("/v1/sessions") ? json({ data: [SESSION], total_count: 1 }) : undefined),
    });
    renderPage(<SessionsPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Revoke session for ada@example.com/ }));
    expect(screen.getByText("Revoke this session?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Revoke session" }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/v1/sessions/sess_1/revoke"))).toBe(true);
    });
  });

  it("keeps typing while a filter change rewrites the URL in the debounce window", async () => {
    mockApi({
      handle: (call) => (call.url.includes("/v1/sessions") ? json({ data: [SESSION], total_count: 1 }) : undefined),
    });
    renderPage(<SessionsPage />);
    await screen.findByText("Ada Lovelace");

    vi.useFakeTimers();
    try {
      const input = screen.getByLabelText("Filter sessions by user") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "abc" } });
      // The sort click rewrites the query string before the 400ms debounce commits the typed value.
      fireEvent.click(screen.getByRole("button", { name: "Sort by Started" }));
      expect((screen.getByLabelText("Filter sessions by user") as HTMLInputElement).value).toBe("abc");
    } finally {
      vi.useRealTimers();
    }
  });

  it("filters by status through the URL", async () => {
    const calls = mockApi({
      handle: (call) => (call.url.includes("/v1/sessions") ? json({ data: [SESSION], total_count: 1 }) : undefined),
    });
    renderPage(<SessionsPage />);
    await screen.findByText("Ada Lovelace");

    const trigger = screen.getByRole("combobox", { name: "Filter sessions by status" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Revoked" }));

    await waitFor(() => {
      expect(calls.some((call) => call.url.includes("status=revoked"))).toBe(true);
    });
  });
});
