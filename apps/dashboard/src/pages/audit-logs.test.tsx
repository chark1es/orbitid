import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { AuditLogJSON } from "@orbitid/shared";
import AuditLogsPage from "./audit-logs";
import { mockApi, pendingApi, renderPage } from "./_config/__tests__/harness";

const LOG = {
  id: "aud_1",
  action: "user.created",
  actor: "user_admin",
  target_type: "user",
  target_id: "user_1",
  ip: "203.0.113.7",
  metadata: { email: "ada@example.com" },
  created_at: 1_700_000_000_000,
} as unknown as AuditLogJSON;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const list = (data: unknown[], total = data.length) => json({ data, total_count: total });

describe("audit logs page", () => {
  it("shows the loading skeleton", () => {
    pendingApi();
    renderPage(<AuditLogsPage />);
    expect(screen.getByLabelText("Loading rows")).toBeTruthy();
  });

  it("renders the empty state", async () => {
    mockApi();
    renderPage(<AuditLogsPage />);
    expect(await screen.findByText("No audit events")).toBeTruthy();
  });

  it("renders events and opens their metadata", async () => {
    mockApi({ handle: (call) => (call.url.includes("/v1/audit_logs") ? list([LOG], 1) : undefined) });
    renderPage(<AuditLogsPage />);

    expect(await screen.findByText("user.created")).toBeTruthy();
    expect(screen.getByText("1 events")).toBeTruthy();
    // Low-value columns leave the table below xl so a 768/1024px window does not scroll sideways.
    expect(screen.getByRole("columnheader", { name: "Actor" }).className).toContain("hidden");
    expect(screen.getByRole("columnheader", { name: "Actor" }).className).toContain("xl:table-cell");
    fireEvent.click(screen.getByRole("button", { name: "Metadata for user.created" }));

    const sheet = await screen.findByRole("dialog");
    expect(sheet.textContent).toContain("ada@example.com");
    expect(sheet.textContent).toContain("203.0.113.7");
  });

  it("shows the list error", async () => {
    mockApi({
      handle: (call) =>
        call.url.includes("/v1/audit_logs") ? json({ errors: [{ long_message: "Audit store unavailable" }] }, 500) : undefined,
    });
    renderPage(<AuditLogsPage />);
    expect(await screen.findByText(/Audit store unavailable/)).toBeTruthy();
  });

  it("filters by action through the request", async () => {
    const calls = mockApi({ handle: (call) => (call.url.includes("/v1/audit_logs") ? list([LOG], 1) : undefined) });
    renderPage(<AuditLogsPage />);
    await screen.findByText("user.created");

    fireEvent.change(screen.getByLabelText("Filter by action"), { target: { value: "user.created" } });
    await waitFor(() => {
      expect(calls.some((call) => call.url.includes("action=user.created"))).toBe(true);
    });
  });

  it("wraps a long action token instead of widening the row", async () => {
    const longAction = `operator_session.created_${"x".repeat(120)}`;
    mockApi({ handle: (call) => (call.url.includes("/v1/audit_logs") ? list([{ ...LOG, action: longAction }], 1) : undefined) });
    renderPage(<AuditLogsPage />);

    const cell = await screen.findByText(longAction);
    expect(cell.tagName).toBe("CODE");
    expect(cell.className).toContain("break-all");
    expect(cell.getAttribute("title")).toBe(longAction);
  });

  it("keeps a 200-character target id inside the stacked value cell", async () => {
    const longTarget = `user_${"a".repeat(195)}`;
    mockApi({
      handle: (call) =>
        call.url.includes("/v1/audit_logs") ? list([{ ...LOG, target_id: longTarget }], 1) : undefined,
    });

    const restore = (() => {
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
    })();

    try {
      renderPage(<AuditLogsPage />);
      // Wait for the media query to flip the table into stacked rows before looking for a <dd>.
      await waitFor(() => expect(document.querySelector('[data-slot="data-table-stack"]')).toBeTruthy());
      const value = await screen.findByTitle(longTarget);
      const cell = value.closest("dd");
      expect(cell).toBeTruthy();
      expect(cell!.className).toContain("min-w-0");
      expect(cell!.className).toContain("overflow-hidden");
      expect(cell!.className).toContain("[&_.font-data]:break-all");
    } finally {
      restore();
    }
  });

  it("pages forward with an offset", async () => {
    const calls = mockApi({ handle: (call) => (call.url.includes("/v1/audit_logs") ? list([LOG], 120) : undefined) });
    renderPage(<AuditLogsPage />);
    await screen.findByText("user.created");

    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await waitFor(() => {
      expect(calls.some((call) => call.url.includes("offset=50"))).toBe(true);
    });
  });
});
