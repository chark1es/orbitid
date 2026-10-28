import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { SessionJSON } from "@orbitid/shared";
import { api } from "./api";
import { errorMessage } from "./errors";

export type UserAdminAction =
  | "ban"
  | "unban"
  | "lock"
  | "unlock"
  | "delete"
  | "reset-mfa"
  | "revoke-sessions";

/**
 * Backend user mutations with optimistic-UI-free invalidation. Actions resolve to `true` when the
 * server accepted them, so callers can navigate after a delete.
 */
export function useUserAdmin(userId: string, options: { onDeleted?: () => void } = {}) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<UserAdminAction | null>(null);

  async function run<T>(action: UserAdminAction, request: () => Promise<T>, success: string): Promise<T | undefined> {
    setPending(action);
    try {
      const result = await request();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["users"] }),
        queryClient.invalidateQueries({ queryKey: ["user", userId] }),
        queryClient.invalidateQueries({ queryKey: ["stats"] }),
        queryClient.invalidateQueries({ queryKey: ["sessions"] }),
      ]);
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
    resetMfa: () => run("reset-mfa", () => api("DELETE", `/users/${userId}/mfa`), "MFA reset — authenticator and backup codes removed"),
    deleteUser: async () => {
      const result = await run("delete", () => api("DELETE", `/users/${userId}`), "User deleted");
      if (result !== undefined) options.onDeleted?.();
      return result !== undefined;
    },
    revokeSessions: () =>
      run(
        "revoke-sessions",
        async () => {
          const list = await api<{ data: SessionJSON[] }>(
            "GET",
            `/sessions?user_id=${encodeURIComponent(userId)}&status=active&limit=100`,
          );
          const sessions = list.data ?? [];
          await Promise.all(sessions.map((session) => api("POST", `/sessions/${session.id}/revoke`)));
          return sessions.length;
        },
        "All active sessions revoked",
      ),
  };
}
