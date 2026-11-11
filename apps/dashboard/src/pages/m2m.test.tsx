import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { M2MMachineJSON, M2MTokenJSON } from "@orbitid/shared";
import M2MPage from "./m2m";
import { mockApi, pendingApi, renderPage } from "./_config/__tests__/harness";

const MACHINE = {
  id: "mch_1",
  name: "reporting-worker",
  default_token_ttl: 3600,
  scoped_machines: [],
  created_at: 1_700_000_000_000,
} as unknown as M2MMachineJSON;

const TOKEN = {
  id: "mt_1",
  machine_id: "mch_1",
  revoked: false,
  expired: false,
  expiration: 1_700_100_000_000,
  claims: { scope: "reports" },
  created_at: 1_700_000_000_000,
} as unknown as M2MTokenJSON;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const list = (data: unknown[], total = data.length) => json({ data, total_count: total });

describe("M2M page", () => {
  it("shows loading rows", () => {
    pendingApi();
    renderPage(<M2MPage />);
    expect(screen.getAllByLabelText("Loading rows").length).toBeGreaterThan(0);
  });

  it("renders both empty sections", async () => {
    mockApi();
    renderPage(<M2MPage />);
    expect(await screen.findByText("No machines")).toBeTruthy();
    expect(screen.getByText("No tokens")).toBeTruthy();
  });

  it("renders machines and tokens and counts every machine page", async () => {
    const calls = mockApi({
      handle: (call) => {
        if (call.url.includes("/v1/m2m/machines")) {
          return call.url.includes("offset=0")
            ? list(Array.from({ length: 100 }, (_, index) => ({ ...MACHINE, id: `mch_${index}`, name: `Machine ${index}` })), 101)
            : list([{ ...MACHINE, id: "mch_100", name: "Last machine" }], 101);
        }
        if (call.url.includes("/v1/m2m/tokens")) return list([TOKEN], 1);
        return undefined;
      },
    });
    renderPage(<M2MPage />);

    expect(await screen.findByText("101 machines")).toBeTruthy();
    expect(await screen.findByText("Last machine")).toBeTruthy();
    // Name and id share one line: a stacked pair made every machine row 59px instead of 40px.
    const machineCell = screen.getByText("Last machine").parentElement!;
    expect(machineCell.className).toContain("items-baseline");
    expect(machineCell.className).not.toContain("space-y");
    expect(screen.getAllByText("Machine 1").length).toBeGreaterThan(0);
    expect(calls.some((call) => call.url.includes("offset=100"))).toBe(true);
  });

  it("hides scoped machines and created dates so the tables fit at 768", async () => {
    mockApi({
      handle: (call) => {
        if (call.url.includes("/v1/m2m/machines")) return list([MACHINE], 1);
        if (call.url.includes("/v1/m2m/tokens")) return list([TOKEN], 1);
        return undefined;
      },
    });
    renderPage(<M2MPage />);
    await screen.findAllByText("reporting-worker");

    const scoped = screen.getByRole("columnheader", { name: "Scoped machines" });
    expect(scoped.className).toContain("hidden");
    expect(scoped.className).toContain("xl:table-cell");
    const created = screen.getAllByRole("columnheader", { name: "Created" });
    expect(created.length).toBeGreaterThan(0);
    for (const head of created) {
      expect(head.className).toContain("hidden");
      expect(head.className).toContain("lg:table-cell");
    }
    expect(screen.getAllByRole("columnheader", { name: "Machine" }).length).toBe(2);
    expect(screen.getAllByRole("columnheader", { name: "Actions" }).length).toBeGreaterThan(0);
  });

  it("does not show a validation list until the create form is submitted", async () => {
    mockApi({
      handle: (call) => {
        if (call.url.includes("/v1/m2m/machines")) return list([], 0);
        if (call.url.includes("/v1/m2m/tokens")) return list([], 0);
        return undefined;
      },
    });
    renderPage(<M2MPage />);
    await screen.findByText("No machines");

    fireEvent.click(screen.getAllByRole("button", { name: /Create machine/ })[0]!);
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).queryByText("Fix this before saving")).toBeNull();

    fireEvent.click(within(sheet).getByRole("button", { name: "Create machine" }));
    expect(await within(sheet).findByText("Fix this before saving")).toBeTruthy();
    expect(within(sheet).getByText("Machine name is required.")).toBeTruthy();
  });

  it("shows a machine load error", async () => {
    mockApi({
      handle: (call) =>
        call.url.includes("/v1/m2m/machines") ? json({ errors: [{ long_message: "Machines unavailable" }] }, 500) : undefined,
    });
    renderPage(<M2MPage />);
    expect(await screen.findByText(/Machines unavailable/)).toBeTruthy();
  });

  it("creates a machine and reveals its one-time secret", async () => {
    const calls = mockApi({
      handle: (call) => {
        if (call.method === "POST" && call.url.endsWith("/v1/m2m/machines")) return json({ ...MACHINE, secret: "mk_secret" });
        if (call.url.includes("/v1/m2m/machines")) return list([MACHINE]);
        if (call.url.includes("/v1/m2m/tokens")) return list([]);
        return undefined;
      },
    });
    renderPage(<M2MPage />);
    await screen.findByText("reporting-worker");

    fireEvent.click(screen.getAllByRole("button", { name: /Create machine/ })[0]!);
    const sheet = await screen.findByRole("dialog");
    fireEvent.change(within(sheet).getByLabelText(/Name/), { target: { value: "billing-worker" } });
    fireEvent.change(within(sheet).getByLabelText(/Default token TTL/), { target: { value: "900" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Create machine" }));

    await waitFor(() => {
      expect(calls.find((call) => call.method === "POST" && call.url.endsWith("/v1/m2m/machines"))?.body).toEqual({
        name: "billing-worker",
        default_token_ttl: 900,
        scoped_machines: [],
      });
    });
    fireEvent.click(await screen.findByRole("button", { name: "Reveal secret" }));
    expect(await screen.findByText("mk_secret")).toBeTruthy();
  });

  it("revokes a token only after confirmation", async () => {
    const calls = mockApi({
      handle: (call) => {
        if (call.url.includes("/v1/m2m/machines")) return list([MACHINE]);
        if (call.url.includes("/v1/m2m/tokens")) return list([TOKEN]);
        return undefined;
      },
    });
    renderPage(<M2MPage />);

    fireEvent.click(await screen.findByTitle("Revoke"));
    expect(screen.getByText("Revoke token?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Revoke token" }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/v1/m2m/tokens/mt_1/revoke"))).toBe(true);
    });
  });
});
