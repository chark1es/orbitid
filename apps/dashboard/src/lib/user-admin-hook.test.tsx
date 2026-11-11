import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { useUserAdmin } from "./user-admin";

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, api: vi.fn() };
});
const notifications = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: notifications }));

const session = (id: string) => ({ id, status: "active" }) as never;

function Harness() {
  const admin = useUserAdmin("user_1");
  return (
    <button type="button" onClick={() => void admin.revokeSessions()}>
      Revoke sessions
    </button>
  );
}

function renderHarness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
  return { invalidate };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useUserAdmin revoke-sessions", () => {
  it("invalidates every affected query and reports a partial failure by count", async () => {
    vi.mocked(api).mockImplementation(async (method, path) => {
      if (method === "GET") {
        return { data: [session("sess_1"), session("sess_2"), session("sess_3")] } as never;
      }
      if (path === "/sessions/sess_2/revoke") throw new Error("session already ended");
      return {} as never;
    });
    const { invalidate } = renderHarness();

    fireEvent.click(screen.getByRole("button", { name: "Revoke sessions" }));

    await waitFor(() => expect(notifications.error).toHaveBeenCalledWith("Revoked 2 of 3 sessions"));
    expect(notifications.success).not.toHaveBeenCalled();
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toEqual(
      expect.arrayContaining([["users"], ["user", "user_1"], ["stats"], ["sessions"]]),
    );
  });

  it("still invalidates the cached list when the session read fails", async () => {
    vi.mocked(api).mockRejectedValue(new Error("network down"));
    const { invalidate } = renderHarness();

    fireEvent.click(screen.getByRole("button", { name: "Revoke sessions" }));

    await waitFor(() => expect(notifications.error).toHaveBeenCalled());
    expect(notifications.error.mock.calls[0]?.[0]).toContain("network down");
    expect(invalidate).toHaveBeenCalledTimes(4);
  });
});
