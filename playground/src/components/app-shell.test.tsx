// @vitest-environment jsdom
import * as React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./app-shell";
import { ThemeProvider } from "./theme-provider";
import type { InstanceStatus } from "@/lib/env";

const auth = vi.hoisted(() => ({ signedIn: false, userId: "user_1" }));

vi.mock("@orbitid/react", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: auth.signedIn, userId: auth.userId }),
  UserButton: () => <button data-testid="playground-user-button">Account</button>,
}));

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: React.ComponentProps<"a">) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const STATUS: InstanceStatus = {
  publishableKey: "pk_test_demo",
  publishableKeyValid: true,
  publishableKeyEnv: "test",
  frontendApi: "https://auth.example.com",
  apiUrl: "https://auth.example.com",
  apiUrlFromKey: true,
  secretKeyPresent: false,
  webhookSecretPresent: false,
  health: {
    reachable: true,
    status: 200,
    database: "postgres",
    latencyMs: 4,
    keyMatches: true,
    error: null,
    checkedAt: 0,
  },
};

function renderShell() {
  return render(
    <ThemeProvider>
      <AppShell status={STATUS} hasProvider>
        <p>content</p>
      </AppShell>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  document.documentElement.classList.remove("dark");
});

afterEach(() => {
  cleanup();
  auth.signedIn = false;
});

describe("playground header account control", () => {
  it("hides the not-for-production badge below sm so the page title keeps its room", () => {
    renderShell();
    const badge = screen.getByText("Not for production").parentElement!;
    // The same sentence is repeated inside the mobile navigation panel and the rail footer.
    expect(badge.className).toContain("hidden");
    expect(badge.className).toContain("sm:inline-flex");
    const title = document.querySelector("header p")!;
    expect(title.textContent).toBe("Setup");
    expect(title.className).toContain("min-w-0");
    expect(title.className).toContain("flex-1");
    expect(title.className).toContain("truncate");
  });

  it("mounts the SDK UserButton for a signed-in visitor", () => {
    auth.signedIn = true;
    renderShell();
    expect(screen.getByTestId("playground-user-button")).toBeTruthy();
  });

  it("keeps the UserButton out of the header while signed out", () => {
    renderShell();
    expect(screen.queryByTestId("playground-user-button")).toBeNull();
    expect(screen.getAllByText("Sign in").length).toBeGreaterThan(0);
  });
});
