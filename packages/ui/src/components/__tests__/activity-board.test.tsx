import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { ActivityBoard, activityMethodLabel, type ActivityRow } from "../activity-board";

function row(overrides: Partial<ActivityRow> & { id: string; at: Date }): ActivityRow {
  return {
    method: "password",
    who: "Ada Lovelace",
    whoSub: "ada@example.com",
    where: "Chrome 130, Lisbon",
    outcome: "success",
    ...overrides,
  };
}

function atToday(hours: number, minutes: number): Date {
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return date;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ActivityBoard", () => {
  it("renders the departures columns with time, line code, who, where and outcome", () => {
    const at = atToday(14, 2);
    render(<ActivityBoard rows={[row({ id: "row-1", at })]} />);

    for (const header of ["Time", "Line", "Who", "Where", "Outcome"]) {
      expect(screen.getByRole("columnheader", { name: header })).toBeTruthy();
    }

    const bodyRow = screen.getAllByRole("row")[1];
    const cells = within(bodyRow).getAllByRole("cell");
    expect(cells[0]?.textContent).toBe("14:02");
    expect(cells[0]?.querySelector("[title]")?.getAttribute("title")).toBe(at.toISOString());
    expect(screen.getByRole("img", { name: "Password" }).textContent).toBe("P");
    expect(cells[2]?.textContent).toContain("Ada Lovelace");
    expect(cells[2]?.textContent).toContain("ada@example.com");
    expect(cells[3]?.textContent).toBe("Chrome 130, Lisbon");
    expect(cells[4]?.textContent).toContain("Success");
  });

  it("marks a failed attempt on the line code and names the outcome in words", () => {
    render(
      <ActivityBoard
        rows={[row({ id: "row-1", at: atToday(9, 30), outcome: "failed", detail: "Wrong password" })]}
      />,
    );

    const chip = screen.getByRole("img", { name: "Password, failed" });
    expect(chip.className).toContain("bg-signal");
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("Wrong password")).toBeTruthy();
  });

  it("prefixes the weekday when a row is not from today", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 28, 12, 0));
    render(<ActivityBoard rows={[row({ id: "row-1", at: new Date(2026, 9, 26, 9, 5) })]} />);

    expect(screen.getByText("Mon 09:05")).toBeTruthy();
  });

  it("orders rows newest first and limits them to maxRows", () => {
    const rows = [
      row({ id: "old", at: new Date(2026, 9, 20, 8, 0), who: "Old session" }),
      row({ id: "new", at: new Date(2026, 9, 28, 8, 0), who: "New session" }),
      row({ id: "middle", at: new Date(2026, 9, 24, 8, 0), who: "Middle session" }),
    ];
    render(<ActivityBoard rows={rows} maxRows={2} />);

    const names = screen
      .getAllByRole("row")
      .slice(1)
      .map((tableRow) => within(tableRow).getAllByRole("cell")[2]?.textContent ?? "");
    expect(names).toHaveLength(2);
    expect(names[0]).toContain("New session");
    expect(names[1]).toContain("Middle session");
  });

  it("highlights only rows newer than highlightNewSince", () => {
    const since = new Date(2026, 9, 28, 10, 0).getTime();
    render(
      <ActivityBoard
        highlightNewSince={since}
        rows={[
          row({ id: "fresh", at: new Date(2026, 9, 28, 10, 1) }),
          row({ id: "seen", at: new Date(2026, 9, 28, 9, 59) }),
        ]}
      />,
    );

    const fresh = screen.getAllByRole("row")[1];
    const seen = screen.getAllByRole("row")[2];
    expect(fresh?.getAttribute("data-new")).toBe("true");
    expect(fresh?.className).toContain("activity-row-new");
    expect(seen?.getAttribute("data-new")).toBeNull();
  });

  it("shows a titled empty state with a hint", () => {
    render(<ActivityBoard rows={[]} />);
    expect(screen.getByText("No activity yet")).toBeTruthy();
    expect(screen.queryAllByRole("table")).toHaveLength(0);
  });

  it("accepts a caller supplied empty state", () => {
    render(<ActivityBoard rows={[]} emptyTitle="No sign-ins for this user" emptyHint="Attempts appear here once they happen." />);
    expect(screen.getByText("No sign-ins for this user")).toBeTruthy();
    expect(screen.getByText("Attempts appear here once they happen.")).toBeTruthy();
  });

  it("renders skeleton rows and a busy status while loading", () => {
    render(<ActivityBoard rows={[row({ id: "row-1", at: atToday(11, 0) })]} loading />);
    expect(screen.getByRole("status").textContent).toBe("Loading activity");
    expect(screen.queryByText("Ada Lovelace")).toBeNull();
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  it("stacks the departures board into labelled rows below sm", () => {
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
    try {
      render(<ActivityBoard rows={[row({ id: "row-1", at: atToday(14, 2) })]} />);
      expect(screen.queryByRole("table")).toBeNull();
      const stack = document.querySelector('[data-slot="activity-stack"]');
      expect(stack).toBeTruthy();
      expect(stack?.textContent).toContain("Ada Lovelace");
      expect(stack?.textContent).toContain("14:02");
      expect(stack?.textContent).toContain("Chrome 130, Lisbon");
      expect(stack?.textContent).toContain("Success");
      expect(screen.getByRole("img", { name: "Password" }).textContent).toBe("P");
    } finally {
      Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: original });
    }
  });
});

describe("activityMethodLabel", () => {
  it("names each method", () => {
    expect(activityMethodLabel("password")).toBe("Password");
    expect(activityMethodLabel("email_code")).toBe("Email code");
    expect(activityMethodLabel("email_link")).toBe("Email link");
    expect(activityMethodLabel("sms")).toBe("SMS code");
    expect(activityMethodLabel("passkey")).toBe("Passkey");
    expect(activityMethodLabel("oauth")).toBe("Social sign-in");
    expect(activityMethodLabel("totp")).toBe("Authenticator code");
    expect(activityMethodLabel("backup_code")).toBe("Backup code");
    expect(activityMethodLabel("sso")).toBe("Enterprise SSO");
    expect(activityMethodLabel("ticket")).toBe("Sign-in ticket");
    expect(activityMethodLabel("unknown")).toBe("Unknown method");
  });
});
