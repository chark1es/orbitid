import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { InvitationJSON } from "@orbitid/shared";
import InvitationsPage from "./invitations";
import { mockApi, pendingApi, renderPage } from "./_config/__tests__/harness";

const INVITATION = {
  id: "inv_1",
  email_address: "new@example.com",
  status: "pending",
  created_at: 1_700_000_000_000,
  expires_at: 1_702_000_000_000,
} as unknown as InvitationJSON;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const list = (data: unknown[], total = data.length) => json({ data, total_count: total });

describe("invitations page", () => {
  it("shows a loading state before rows arrive", () => {
    pendingApi();
    renderPage(<InvitationsPage />);
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy();
  });

  it("renders the empty state", async () => {
    mockApi();
    renderPage(<InvitationsPage />);
    expect(await screen.findByText("No invitations yet")).toBeTruthy();
    expect(screen.getByText("No invitations yet").closest("[data-variant]")?.getAttribute("data-variant")).toBe("compact");
  });

  it("renders invitations and paginates with the server total", async () => {
    mockApi({ handle: (call) => (call.url.includes("/v1/invitations") ? list([INVITATION], 45) : undefined) });
    renderPage(<InvitationsPage />);

    expect(await screen.findByText("new@example.com")).toBeTruthy();
    expect(screen.getByText("Showing 1–20 of 45")).toBeTruthy();
  });

  it("shows a list error", async () => {
    mockApi({
      handle: (call) =>
        call.url.includes("/v1/invitations")
          ? json({ errors: [{ long_message: "List failed" }] }, 503)
          : undefined,
    });
    renderPage(<InvitationsPage />);
    expect(await screen.findByText(/List failed/)).toBeTruthy();
  });

  it("creates a single invitation with the right body", async () => {
    const calls = mockApi({
      handle: (call) => {
        if (call.method === "POST" && call.url.endsWith("/v1/invitations")) {
          return json({ ...INVITATION, url: "https://app.test/invite/ticket" });
        }
        if (call.url.includes("/v1/invitations")) return list([]);
        return undefined;
      },
    });
    renderPage(<InvitationsPage />);
    await screen.findByText("No invitations yet");

    fireEvent.click(screen.getAllByRole("button", { name: /Create invitation/ })[0]!);
    const dialog = await screen.findByRole("dialog");
    // Small forms share the 448px token; the old 512px width was a third arbitrary size.
    expect(dialog.className).toContain("sm:max-w-md");
    expect(dialog.className).not.toContain("sm:max-w-lg");
    fireEvent.change(within(dialog).getByLabelText("Email address"), { target: { value: "new@example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Create invitation/ }));

    await waitFor(() => {
      expect(calls.find((call) => call.method === "POST" && call.url.endsWith("/v1/invitations"))?.body).toEqual({
        email_address: "new@example.com",
        notify: true,
        expires_in_days: 30,
      });
    });
  });

  it("revokes an invitation after confirmation", async () => {
    const calls = mockApi({
      handle: (call) => (call.url.includes("/v1/invitations") ? list([INVITATION]) : undefined),
    });
    renderPage(<InvitationsPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Revoke invitation for new@example.com/ }));
    expect(screen.getByText("Revoke invitation?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Revoke invitation" }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/v1/invitations/inv_1/revoke"))).toBe(true);
    });
  });

  it("keeps typed search text when a sort rewrites the URL before the debounce", async () => {
    mockApi({ handle: (call) => (call.url.includes("/v1/invitations") ? list([INVITATION]) : undefined) });
    renderPage(<InvitationsPage />);
    await screen.findByText("new@example.com");

    vi.useFakeTimers();
    try {
      fireEvent.change(screen.getByLabelText("Search invitations"), { target: { value: "ada" } });
      fireEvent.click(screen.getByRole("button", { name: "Sort by Created" }));
      expect((screen.getByLabelText("Search invitations") as HTMLInputElement).value).toBe("ada");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("invitations long values", () => {
  it("truncates a long email so the desktop row stays one line", async () => {
    const longEmail = `${"very.long.local.part.".repeat(8)}@example.com`;
    mockApi({
      handle: (call) =>
        call.url.includes("/v1/invitations") ? list([{ ...INVITATION, email_address: longEmail }], 1) : undefined,
    });
    renderPage(<InvitationsPage />);

    const cell = await screen.findByText(longEmail);
    expect(cell.className).toContain("truncate");
    expect(cell.className).toContain("max-w-[36ch]");
    expect(cell.getAttribute("title")).toBe(longEmail);
  });
});
