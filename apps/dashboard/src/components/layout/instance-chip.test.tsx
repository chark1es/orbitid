import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { InstanceChip } from "./instance-chip";

describe("InstanceChip", () => {
  it("keeps only the short environment label below lg and the host from lg up", async () => {
    sessionStorage.setItem("orbitid.apiUrl", "http://localhost:4000");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "ok", database: "postgres", database_driver: "postgres" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    render(<InstanceChip />);

    const database = await screen.findByText("Postgres");
    // The short label stays at every width: the chip still says which instance it points at.
    expect(database.className).not.toContain("hidden");
    expect(database.className).toContain("truncate");
    const host = await screen.findByText("localhost:4000");
    // The full host would take the room the breadcrumb needs below 1024px; it stays in the tooltip.
    expect(host.className).toContain("hidden");
    expect(host.className).toContain("lg:inline");
    expect(host.className).toContain("truncate");
    const chip = host.parentElement!;
    expect(chip.getAttribute("title")).toBe("Postgres · http://localhost:4000");
    expect(chip.className).toContain("lg:max-w-[16rem]");
  });

  it("names an older SQLite server and explains that it is unsupported", async () => {
    sessionStorage.setItem("orbitid.apiUrl", "http://localhost:4000");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "ok", database: "sqlite" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    render(<InstanceChip />);

    expect(await screen.findByText("SQLite")).toBeTruthy();
    expect(screen.getByTitle(/SQLite · http:\/\/localhost:4000 — This instance runs SQLite/)).toBeTruthy();
  });
});
