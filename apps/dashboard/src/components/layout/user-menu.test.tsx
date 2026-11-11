import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AuthProvider, RequireAuth, useAuth } from "../../lib/auth";
import { UserMenu } from "./user-menu";

const SESSION = { object: "operator_session", id: "osess_1", expires_at: Date.now() + 3_600_000 };
const notifications = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: notifications }));

function SessionState() {
  return <output>{useAuth().authenticated ? "Authenticated" : "Signed out"}</output>;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function renderMenu() {
  sessionStorage.setItem("orbitid.apiUrl", "http://localhost:4000");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AuthProvider>
          <RequireAuth>
            <SessionState />
            <UserMenu />
          </RequireAuth>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Radix opens the menu from the keyboard; jsdom has no pointer-capture implementation for it. */
async function openMenu() {
  const trigger = await screen.findByRole("button", { name: "Instance menu" });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter" });
  return trigger;
}

describe("sign out menu", () => {
  it("keeps the session when revocation fails, so sign-out is never claimed falsely", async () => {
    notifications.error.mockClear();
    notifications.success.mockClear();
    const deletes: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const method = init?.method ?? "GET";
      if (method === "DELETE") {
        deletes.push("DELETE");
        // The session is NOT revoked: the row is still live and the cookie still works.
        return json({ errors: [{ code: "internal_server_error", message: "Server error" }] }, 500);
      }
      return json(SESSION);
    });

    renderMenu();
    expect(await screen.findByText("Authenticated")).toBeTruthy();
    await openMenu();
    expect(await screen.findByText("Operator session")).toBeTruthy();

    fireEvent.click(screen.getByRole("menuitem", { name: /Sign out/ }));

    // The action was attempted, and the UI did not navigate to /login or show "Signed out".
    await waitFor(() => expect(deletes).toHaveLength(1));
    await waitFor(() => expect(notifications.error).toHaveBeenCalledWith("Could not sign out", expect.any(Object)));
    expect(screen.getByText("Authenticated")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Instance menu" })).toBeTruthy();
    expect(notifications.success).not.toHaveBeenCalled();
    expect(screen.queryByText("Signed out")).toBeNull();
  });
});

describe("account trigger", () => {
  it("shows the operator word, not invented initials", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(SESSION));
    renderMenu();
    const trigger = await screen.findByRole("button", { name: "Instance menu" });
    expect(trigger.textContent).toContain("Admin");
    expect(trigger.textContent).not.toContain("IA");
    expect(trigger.querySelector('[data-slot="avatar"]')).toBeNull();
  });
});
