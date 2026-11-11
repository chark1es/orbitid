import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { SessionJSON } from "@orbitid/shared";
import { api } from "./api";
import { errorMessage } from "./errors";

const SESSION_PAGE_SIZE = 100;

/**
 * Revokes every active session a user has, not just the first page. The query is live: every revoked
 * session drops out of the `status=active` list, so the loop always reads the first page again and
 * skips ids it has already revoked. Re-reading `offset=0` is what makes a shrinking list safe; walking
 * an offset forward would skip over the sessions that moved into the space the revoked ones left.
 */
export interface RevokeSessionsResult {
  revoked: number;
  failed: number;
  total: number;
}

export async function revokeAllUserSessions(userId: string): Promise<RevokeSessionsResult> {
  let revoked = 0;
  let failed = 0;
  const done = new Set<string>();
  for (;;) {
    const list = await api<{ data: SessionJSON[]; total_count?: number }>(
      "GET",
      `/sessions?user_id=${encodeURIComponent(userId)}&status=active&limit=${SESSION_PAGE_SIZE}&offset=0`,
    );
    const sessions = (list.data ?? []).filter((session) => !done.has(session.id));
    // Empty means there is nothing left; an all-known page means the server did not shrink the list.
    if (sessions.length === 0) break;
    // One refusal must not abandon the revokes that can still succeed, so wait for every request
    // and count the outcomes instead of rejecting on the first failure.
    const results = await Promise.allSettled(
      sessions.map((session) => api("POST", `/sessions/${session.id}/revoke`)),
    );
    for (const session of sessions) done.add(session.id);
    for (const result of results) {
      if (result.status === "fulfilled") revoked += 1;
      else failed += 1;
    }
    if (sessions.length < SESSION_PAGE_SIZE) break;
  }
  return { revoked, failed, total: revoked + failed };
}

export type UserAdminAction =
  | "ban"
  | "unban"
  | "lock"
  | "unlock"
  | "delete"
  | "revoke-sessions";

/**
 * Backend user mutations with optimistic-UI-free invalidation. Actions resolve to `true` when the
 * server accepted them, so callers can navigate after a delete.
 */
export function useUserAdmin(userId: string, options: { onDeleted?: () => void } = {}) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<UserAdminAction | null>(null);

  function invalidate() {
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: ["users"] }),
      queryClient.invalidateQueries({ queryKey: ["user", userId] }),
      queryClient.invalidateQueries({ queryKey: ["stats"] }),
      queryClient.invalidateQueries({ queryKey: ["sessions"] }),
    ]);
  }

  async function run<T>(action: UserAdminAction, request: () => Promise<T>, success: string): Promise<T | undefined> {
    setPending(action);
    try {
      const result = await request();
      await invalidate();
      toast.success(success);
      return result;
    } catch (error) {
      toast.error(errorMessage(error));
      return undefined;
    } finally {
      setPending(null);
    }
  }

  return {
    pending,
    ban: () => run("ban", () => api("POST", `/users/${userId}/ban`), "User banned"),
    unban: () => run("unban", () => api("POST", `/users/${userId}/unban`), "User unbanned"),
    lock: () => run("lock", () => api("POST", `/users/${userId}/lock`), "User locked"),
    unlock: () => run("unlock", () => api("POST", `/users/${userId}/unlock`), "User unlocked"),
    deleteUser: async () => {
      const result = await run("delete", () => api("DELETE", `/users/${userId}`), "User deleted");
      if (result !== undefined) options.onDeleted?.();
      return result !== undefined;
    },
    revokeSessions: async (): Promise<RevokeSessionsResult | undefined> => {
      setPending("revoke-sessions");
      try {
        const result = await revokeAllUserSessions(userId);
        // A partial failure still revoked sessions: refresh the list before reporting the outcome.
        await invalidate();
        if (result.failed > 0) toast.error(`Revoked ${result.revoked} of ${result.total} sessions`);
        else toast.success("All active sessions revoked");
        return result;
      } catch (error) {
        // Even a failed list read can leave the cached list stale, so refetch it either way.
        await invalidate();
        toast.error(errorMessage(error));
        return undefined;
      } finally {
        setPending(null);
      }
    },
  };
}
