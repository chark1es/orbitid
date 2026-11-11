import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { WaitlistEntryJSON } from "@orbitid/shared";
import WaitlistPage from "./waitlist";
import { mockApi, pendingApi, renderPage } from "./_config/__tests__/harness";

const ENTRY = {
  id: "wl_1",
  email_address: "waiting@example.com",
  status: "pending",
  invitation: null,
  created_at: 1_700_000_000_000,
} as unknown as WaitlistEntryJSON;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const list = (data: unknown[], total = data.length) => json({ data, total_count: total });

describe("waitlist page", () => {
  it("shows a loading state", () => {
    pendingApi();
    renderPage(<WaitlistPage />);
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy();
  });

  it("renders the empty state", async () => {
    mockApi();
    renderPage(<WaitlistPage />);
    expect(await screen.findByText("The waitlist is empty")).toBeTruthy();
  });

  it("renders entries with pagination", async () => {
    mockApi({ handle: (call) => (call.url.includes("/v1/waitlist_entries") ? list([ENTRY], 62) : undefined) });
    renderPage(<WaitlistPage />);

    expect(await screen.findByText("waiting@example.com")).toBeTruthy();
    expect(screen.getByText("Showing 1–20 of 62")).toBeTruthy();
  });

  it("shows an error", async () => {
    mockApi({
      handle: (call) =>
        call.url.includes("/v1/waitlist_entries")
          ? json({ errors: [{ long_message: "Waitlist unavailable" }] }, 500)
          : undefined,
    });
    renderPage(<WaitlistPage />);
    expect(await screen.findByText(/Waitlist unavailable/)).toBeTruthy();
  });

  it("invites an entry through the API", async () => {
    const calls = mockApi({
      handle: (call) => {
        if (call.method === "POST" && call.url.endsWith("/v1/waitlist_entries/wl_1/invite")) {
          return json({ invitation: { url: "https://app.test/invite/wl" } });
        }
        if (call.url.includes("/v1/waitlist_entries")) return list([ENTRY]);
        return undefined;
      },
    });
    renderPage(<WaitlistPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Invite waiting@example.com/ }));
    await waitFor(() => {
      expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/v1/waitlist_entries/wl_1/invite"))).toBe(true);
    });
    expect(await screen.findByText("Invitation link")).toBeTruthy();
  });

  it("rejects an entry through the API", async () => {
    const calls = mockApi({
      handle: (call) => (call.url.includes("/v1/waitlist_entries") ? list([ENTRY]) : undefined),
    });
    renderPage(<WaitlistPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Reject waiting@example.com/ }));
    await waitFor(() => {
      expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/v1/waitlist_entries/wl_1/reject"))).toBe(true);
    });
  });

  it("deletes an entry only after confirmation", async () => {
    const calls = mockApi({
      handle: (call) => (call.url.includes("/v1/waitlist_entries") ? list([ENTRY]) : undefined),
    });
    renderPage(<WaitlistPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Delete waiting@example.com" }));
    expect(screen.getByText("Delete waitlist entry?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete entry" }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === "DELETE" && call.url.endsWith("/v1/waitlist_entries/wl_1"))).toBe(true);
    });
  });

  it("filters by status through the URL", async () => {
    const calls = mockApi({
      handle: (call) => (call.url.includes("/v1/waitlist_entries") ? list([ENTRY]) : undefined),
    });
    renderPage(<WaitlistPage />);
    await screen.findByText("waiting@example.com");

    const trigger = screen.getByRole("combobox", { name: "Filter waitlist by status" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Invited" }));

    await waitFor(() => {
      expect(calls.some((call) => call.url.includes("status=invited"))).toBe(true);
    });
  });
});
