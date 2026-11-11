import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { revokeAllUserSessions } from "./user-admin";

vi.mock("./api", () => ({ api: vi.fn() }));

const session = (id: string) => ({ id, status: "active" }) as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("revokeAllUserSessions", () => {
  it("re-reads the first page of the live list until all 150 sessions are revoked", async () => {
    // The server lists active sessions in pages of 100. Revoking removes them from that list, so a
    // forward offset would skip the 50 sessions that slide into the first page.
    const live = new Map(Array.from({ length: 150 }, (_, index) => [`sess_${index}`, session(`sess_${index}`)]));
    const reads: string[] = [];
    const revokedIds: string[] = [];

    vi.mocked(api).mockImplementation(async (method, path) => {
      if (method === "GET") {
        reads.push(path);
        const offset = Number(new URL(path, "http://localhost").searchParams.get("offset"));
        const limit = Number(new URL(path, "http://localhost").searchParams.get("limit"));
        const page = [...live.values()].slice(offset, offset + limit);
        return { data: page, total_count: live.size } as never;
      }
      const id = decodeURIComponent(path.split("/")[2] ?? "");
      revokedIds.push(id);
      live.delete(id);
      return {} as never;
    });

    await expect(revokeAllUserSessions("user_1")).resolves.toEqual({ revoked: 150, failed: 0, total: 150 });

    // Every read starts at offset 0, so the shrinking list never skips a session.
    expect(reads.every((path) => path.includes("limit=100&offset=0"))).toBe(true);
    // 100 revoked, then the remaining 50 in a short page: the short page ends the loop.
    expect(reads.length).toBe(2);
    expect(revokedIds).toHaveLength(150);
    expect(new Set(revokedIds).size).toBe(150);
    expect(revokedIds).toContain("sess_149");
    expect(live.size).toBe(0);
  });

  it("stops when the server keeps returning the same sessions (no progress)", async () => {
    // A server that does not drop revoked sessions from the active list must not loop forever.
    vi.mocked(api).mockImplementation(async (method) => {
      if (method === "GET") {
        return { data: Array.from({ length: 100 }, (_, index) => session(`sess_${index}`)), total_count: 150 } as never;
      }
      return {} as never;
    });

    await expect(revokeAllUserSessions("user_2")).resolves.toEqual({ revoked: 100, failed: 0, total: 100 });

    const reads = vi.mocked(api).mock.calls.filter(([method]) => method === "GET");
    const posts = vi.mocked(api).mock.calls.filter(([method]) => method === "POST");
    expect(reads).toHaveLength(2);
    expect(posts).toHaveLength(100);
  });

  it("stops after a short page when the server omits total_count", async () => {
    vi.mocked(api).mockImplementation(async (method) => {
      if (method === "GET") return { data: [session("sess_1"), session("sess_2")] } as never;
      return {} as never;
    });

    await expect(revokeAllUserSessions("user_3")).resolves.toEqual({ revoked: 2, failed: 0, total: 2 });
    expect(vi.mocked(api).mock.calls.filter(([method]) => method === "GET")).toHaveLength(1);
  });

  it("keeps revoking the rest when one revocation fails and reports the split", async () => {
    vi.mocked(api).mockImplementation(async (method, path) => {
      if (method === "GET") {
        return { data: [session("sess_1"), session("sess_2"), session("sess_3")] } as never;
      }
      if (path === "/sessions/sess_2/revoke") throw new Error("session already ended");
      return {} as never;
    });

    await expect(revokeAllUserSessions("user_4")).resolves.toEqual({ revoked: 2, failed: 1, total: 3 });
    const posts = vi.mocked(api).mock.calls.filter(([method]) => method === "POST");
    expect(posts.map(([, path]) => path)).toEqual([
      "/sessions/sess_1/revoke",
      "/sessions/sess_2/revoke",
      "/sessions/sess_3/revoke",
    ]);
  });
});
