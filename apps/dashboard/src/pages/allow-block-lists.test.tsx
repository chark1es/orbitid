import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import AllowBlockListsPage from "./allow-block-lists";
import { mockApi, pendingApi, renderPage } from "./_config/__tests__/harness";

const ENTRY = {
  id: "alw_1",
  identifier: "ada@example.com",
  identifier_type: "email_address",
  created_at: 1_700_000_000_000,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const list = (data: unknown[], total = data.length) => json({ data, total_count: total });

describe("allowlist and blocklist page", () => {
  it("shows the settings loading state", () => {
    pendingApi();
    renderPage(<AllowBlockListsPage />);
    expect(screen.getByLabelText("Loading settings")).toBeTruthy();
  });

  it("renders both empty lists and their enforcement switches", async () => {
    mockApi();
    renderPage(<AllowBlockListsPage />);

    expect(await screen.findByText("No allowed identifiers")).toBeTruthy();
    expect(screen.getByRole("switch", { name: /Enable the allowlist/ })).toBeTruthy();
    expect(screen.getByRole("switch", { name: /Enable the blocklist/ })).toBeTruthy();
  });

  it("shows a list error", async () => {
    mockApi({
      handle: (call) =>
        call.url.includes("/v1/allowlist_identifiers") ? json({ errors: [{ long_message: "Allowlist unavailable" }] }, 500) : undefined,
    });
    renderPage(<AllowBlockListsPage />);
    expect(await screen.findByText(/Allowlist unavailable/)).toBeTruthy();
  });

  it("adds a normalised allowed identifier", async () => {
    const calls = mockApi({
      handle: (call) => {
        if (call.method === "POST" && call.url.endsWith("/v1/allowlist_identifiers")) return json(ENTRY);
        if (call.url.includes("/v1/allowlist_identifiers")) return list([]);
        return undefined;
      },
    });
    renderPage(<AllowBlockListsPage />);
    await screen.findByText("No allowed identifiers");

    fireEvent.click(screen.getByRole("button", { name: /Add allowed identifier/ }));
    const sheet = await screen.findByRole("dialog");
    fireEvent.change(within(sheet).getByLabelText(/Email address/), { target: { value: " Ada@Example.com " } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Allow identifier" }));

    await waitFor(() => {
      expect(calls.find((call) => call.method === "POST" && call.url.endsWith("/v1/allowlist_identifiers"))?.body).toEqual({
        identifier: "ada@example.com",
        identifier_type: "email_address",
        notify: false,
      });
    });
  });

  it("removes an entry only after confirmation", async () => {
    const calls = mockApi({
      handle: (call) => (call.url.includes("/v1/allowlist_identifiers") ? list([ENTRY]) : undefined),
    });
    renderPage(<AllowBlockListsPage />);
    expect(await screen.findByText("ada@example.com")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove ada@example.com" }));
    expect(screen.getByText("Remove allowed identifier?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === "DELETE" && call.url.endsWith("/v1/allowlist_identifiers/alw_1"))).toBe(true);
    });
  });

  it("counts entries across every page", async () => {
    const calls = mockApi({
      handle: (call) => {
        if (!call.url.includes("/v1/allowlist_identifiers")) return undefined;
        return call.url.includes("offset=0")
          ? list(Array.from({ length: 100 }, (_, index) => ({ ...ENTRY, id: `alw_${index}`, identifier: `user${index}@example.com` })), 101)
          : list([{ ...ENTRY, id: "alw_100", identifier: "last@example.com" }], 101);
      },
    });
    renderPage(<AllowBlockListsPage />);

    expect(await screen.findByText("Allowlist (101)")).toBeTruthy();
    expect(calls.some((call) => call.url.includes("offset=100"))).toBe(true);
  });
});
