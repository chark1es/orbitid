import type { AuditLogJSON, SessionJSON } from "@orbitid/shared";

/**
 * Mirrors the `ActivityRow` contract exported by `@orbitid/ui`. Kept here so the mapping can be
 * tested without rendering the board.
 */
export type ActivityMethod =
  | "password"
  | "email_code"
  | "email_link"
  | "sms"
  | "passkey"
  | "oauth"
  | "totp"
  | "backup_code"
  | "sso"
  | "ticket"
  | "unknown";

export interface ActivityRow {
  id: string;
  at: number | string | Date;
  method: ActivityMethod;
  who: string;
  whoSub?: string;
  where?: string;
  outcome: "success" | "failed" | "pending";
  detail?: string;
}

const STATUS_DETAIL: Record<string, string> = {
  active: "Active",
  pending: "First factor not finished",
  ended: "Ended",
  expired: "Expired",
  removed: "Removed",
  revoked: "Revoked",
  abandoned: "Abandoned",
  replaced: "Replaced",
};

function nameOf(session: SessionJSON): string {
  const data = session.public_user_data;
  if (!data) return "Unknown user";
  const name = [data.first_name, data.last_name].filter(Boolean).join(" ");
  return name || data.identifier || data.user_id;
}

function whereOf(session: SessionJSON): string | undefined {
  const activity = session.latest_activity;
  if (!activity) return undefined;
  const place = [activity.city, activity.country].filter(Boolean).join(", ");
  const client = [activity.browser_name, activity.device_type === "mobile" || activity.is_mobile ? "mobile" : ""]
    .filter(Boolean)
    .join(" ");
  const parts = [place, activity.ip_address].filter(Boolean);
  return [...parts, client].filter(Boolean).join(" · ") || undefined;
}

/**
 * Maps a session to a board row. The API does not store which method created a session, so the
 * method is `unknown` except where the session itself proves the path: an actor token means the
 * session was minted by impersonation, which the ticket row reports in its detail.
 */
export function sessionActivityRow(session: SessionJSON): ActivityRow {
  const impersonated = session.actor !== null && session.actor !== undefined;
  return {
    id: session.id,
    at: session.created_at,
    method: impersonated ? "ticket" : "unknown",
    who: nameOf(session),
    whoSub: session.public_user_data?.identifier ?? session.public_user_data?.user_id,
    where: whereOf(session),
    outcome: session.status === "pending" ? "pending" : "success",
    detail: impersonated ? "Impersonation" : STATUS_DETAIL[session.status],
  };
}

/** Maps an audit log entry to a board row: who did it, what it was, from where. */
export function auditActivityRow(log: AuditLogJSON): ActivityRow {
  const actor = !log.actor ? "System" : log.actor === "secret_key" ? "Secret key" : log.actor === "anonymous" ? "Anonymous" : log.actor;
  return {
    id: log.id,
    at: log.created_at,
    method: "unknown",
    who: actor,
    whoSub: log.target_id ?? log.target_type ?? undefined,
    where: log.ip ?? undefined,
    outcome: "success",
    detail: log.action,
  };
}

export function sessionActivityRows(sessions: SessionJSON[] | undefined): ActivityRow[] {
  return (sessions ?? []).map(sessionActivityRow);
}
