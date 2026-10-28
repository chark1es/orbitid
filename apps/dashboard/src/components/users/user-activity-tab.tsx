import { Link } from "react-router-dom";
import { ActivityBoard, Button } from "@orbitid/ui";
import type { AuditLogJSON, SessionJSON, UserJSON } from "@orbitid/shared";
import { useApi } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { auditActivityRow, sessionActivityRows, type ActivityRow } from "../../lib/activity";
import { Section } from "../shared/section";

/**
 * A user's activity, newest first: the sessions they signed in with and every recorded change that
 * targets them. Rows come from `/sessions?user_id=` and `/audit_logs?target_id=`.
 */
export function UserActivityTab({ user }: { user: UserJSON }) {
  const sessions = useApi<{ data: SessionJSON[] }>(
    ["user-activity", "sessions", user.id],
    `/sessions?user_id=${encodeURIComponent(user.id)}&limit=25&order_by=-created_at`,
  );
  const logs = useApi<{ data: AuditLogJSON[] }>(
    ["user-activity", "audit", user.id],
    `/audit_logs?target_id=${encodeURIComponent(user.id)}&limit=25&order_by=-created_at`,
  );

  const rows: ActivityRow[] = [
    ...sessionActivityRows(sessions.data?.data),
    ...(logs.data?.data ?? []).map(auditActivityRow),
  ];
  const error = sessions.error ?? logs.error;

  return (
    <Section
      title="Activity"
      description="Sessions for this user and recorded changes that target them."
      actions={
        <Button variant="ghost" size="sm" asChild>
          <Link to="/audit-logs">Full audit log</Link>
        </Button>
      }
      className="border-t-0 pt-0"
    >
      {error ? (
        <p role="alert" className="mb-3 border border-signal/40 bg-signal/5 px-3 py-2 text-sm leading-6">
          Some activity could not be read. {errorMessage(error)} Reload once the server is reachable.
        </p>
      ) : null}
      {sessions.isLoading || logs.isLoading ? (
        <div className="rounded-[4px] border border-border bg-card">
          <ActivityBoard rows={[]} loading />
        </div>
      ) : rows.length === 0 ? (
        <ActivityBoard
          rows={[]}
          emptyTitle="No activity recorded"
          emptyHint="Sessions and changes to this user appear here. Impersonation and admin actions are recorded too."
        />
      ) : (
        <div className="overflow-hidden rounded-[4px] border border-border bg-card">
          <ActivityBoard rows={rows} maxRows={25} />
        </div>
      )}
      <p className="mt-2 max-w-[90ch] text-xs leading-5 text-muted-foreground">
        Sign-in method is not stored on a session, so the line code is <span className="font-data">?</span> for session
        rows. Change rows name the action under the outcome.
      </p>
    </Section>
  );
}
