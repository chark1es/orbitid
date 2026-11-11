import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { InstanceSheet } from "./instance-sheet";
import type { InstanceStatsJSON } from "../../lib/types";

const STATS: InstanceStatsJSON = {
  users_total: 42,
  users_active_7d: 7,
  sessions_active: 3,
  organizations_total: 2,
  signups_by_day: [],
  signins_by_day: [],
  banned_users: 0,
  locked_users: 0,
  mfa_enabled_users: 10,
  top_social_providers: [],
};

function renderSheet(stats: InstanceStatsJSON) {
  return render(
    <MemoryRouter>
      <InstanceSheet stats={stats} loading={false} />
    </MemoryRouter>,
  );
}

describe("InstanceSheet", () => {
  it("sets counts as a ruled definition list at body size", () => {
    renderSheet(STATS);
    expect(screen.getAllByRole("definition")[0]?.textContent).toBe("42");
    expect(screen.getByText("Users").tagName).toBe("DT");
    expect(document.querySelector("dl")?.className).toContain("divide-y");
    expect(screen.queryByText("Users", { selector: "dd" })).toBeNull();
  });

  it("keeps the delta arrow and number together so the cell does not wrap mid-value", () => {
    const days = Array.from({ length: 8 }, (_, index) => ({
      date: `2026-11-0${index + 1}`,
      count: index === 0 ? 1 : 2,
    }));
    renderSheet({ ...STATS, signups_by_day: days });

    const delta = screen.getByText("+13");
    expect(delta.parentElement?.className).toContain("whitespace-nowrap");
    expect(delta.closest("p")?.className).toContain("flex-wrap");
    expect(screen.getByText("vs previous 7 days").className).toContain("whitespace-nowrap");
  });

  it("shows the blocked-account dots only when the count is above zero", () => {
    const first = renderSheet(STATS);
    expect(first.container.querySelector(".bg-signal")).toBeNull();
    expect(first.container.querySelector(".bg-caution")).toBeNull();
    first.unmount();

    const second = renderSheet({ ...STATS, banned_users: 2, locked_users: 1 });
    expect(second.container.querySelector(".bg-signal")).toBeTruthy();
    expect(second.container.querySelector(".bg-caution")).toBeTruthy();
  });
});
