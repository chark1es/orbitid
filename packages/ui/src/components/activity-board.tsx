import * as React from "react";
import { cn } from "../lib/utils";
import { Skeleton } from "./ui/skeleton";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";

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

const METHOD_META: Record<ActivityMethod, { letter: string; label: string }> = {
  password: { letter: "P", label: "Password" },
  email_code: { letter: "E", label: "Email code" },
  email_link: { letter: "M", label: "Email link" },
  sms: { letter: "S", label: "SMS code" },
  passkey: { letter: "K", label: "Passkey" },
  oauth: { letter: "O", label: "Social sign-in" },
  totp: { letter: "T", label: "Authenticator code" },
  backup_code: { letter: "B", label: "Backup code" },
  sso: { letter: "X", label: "Enterprise SSO" },
  ticket: { letter: "I", label: "Sign-in ticket" },
  unknown: { letter: "?", label: "Unknown method" },
};

const OUTCOME_META: Record<ActivityRow["outcome"], { label: string; dot: string }> = {
  success: { label: "Success", dot: "bg-go" },
  failed: { label: "Failed", dot: "bg-signal" },
  pending: { label: "Pending", dot: "bg-caution" },
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function activityMethodLabel(method: ActivityMethod): string {
  return METHOD_META[method]?.label ?? METHOD_META.unknown.label;
}


export interface ActivityBoardProps {
  rows: ActivityRow[];
  loading?: boolean;
  emptyTitle?: string;
  emptyHint?: string;
  maxRows?: number;
  className?: string;
  highlightNewSince?: number;
}

export function ActivityBoard({
  rows,
  loading = false,
  emptyTitle = "No activity yet",
  emptyHint = "Sign-ins and sessions appear here as soon as someone uses this instance.",
  maxRows = 50,
  className,
  highlightNewSince,
}: ActivityBoardProps): React.JSX.Element {
  const now = new Date();
  const ordered = rows
    .map((row) => {
      const date = row.at instanceof Date ? row.at : new Date(row.at);
      return { row, date: Number.isNaN(date.getTime()) ? null : date };
    })
    .sort((a, b) => (b.date?.getTime() ?? -Infinity) - (a.date?.getTime() ?? -Infinity));
  const visible = maxRows > 0 ? ordered.slice(0, maxRows) : ordered;

  if (loading) {
    return (
      <div className={cn("w-full", className)} aria-busy="true">
        <p role="status" className="sr-only">
          Loading activity
        </p>
        <Table>
          <TableCaption className="sr-only">Recent activity, loading</TableCaption>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-[88px]">Time</TableHead>
              <TableHead className="w-[52px]">Line</TableHead>
              <TableHead>Who</TableHead>
              <TableHead className="hidden sm:table-cell">Where</TableHead>
              <TableHead className="w-[136px]">Outcome</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody aria-hidden="true">
            {Array.from({ length: 6 }, (_, index) => (
              <TableRow key={index} className="hover:bg-transparent">
                <TableCell>
                  <Skeleton className="h-4 w-11" />
                </TableCell>
                <TableCell>
                  <Skeleton className="size-[22px] rounded-sm" />
                </TableCell>
                <TableCell>
                  <div className="space-y-1">
                    <Skeleton className="h-3.5 w-32" />
                    <Skeleton className="h-3 w-44" />
                  </div>
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  <Skeleton className="h-4 w-28" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-4 w-16" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }

  if (visible.length === 0) {
    return (
      <div className={cn("w-full rounded-lg border border-dashed border-border px-5 py-10", className)}>
        <p className="text-sm font-semibold">{emptyTitle}</p>
        <p className="mt-1 max-w-[60ch] text-sm text-muted-foreground">{emptyHint}</p>
      </div>
    );
  }

  return (
    <div className={cn("w-full", className)}>
      <Table>
        <TableCaption className="sr-only">Recent activity</TableCaption>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-[88px]">Time</TableHead>
            <TableHead className="w-[52px]">Line</TableHead>
            <TableHead>Who</TableHead>
            <TableHead className="hidden sm:table-cell">Where</TableHead>
            <TableHead className="w-[136px]">Outcome</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.map(({ row, date }) => {
            const method = METHOD_META[row.method] ?? METHOD_META.unknown;
            const outcome = OUTCOME_META[row.outcome] ?? OUTCOME_META.pending;
            const isNew =
              typeof highlightNewSince === "number" && date !== null && date.getTime() > highlightNewSince;
            const clock = `${String(date?.getHours() ?? 0).padStart(2, "0")}:${String(date?.getMinutes() ?? 0).padStart(2, "0")}`;
            const isToday =
              date !== null &&
              date.getFullYear() === now.getFullYear() &&
              date.getMonth() === now.getMonth() &&
              date.getDate() === now.getDate();
            const timeLabel = date ? (isToday ? clock : `${WEEKDAYS[date.getDay()]} ${clock}`) : "--:--";
            const isoTime = date ? date.toISOString() : undefined;
            const lineLabel = `${method.label}${row.outcome === "failed" ? ", failed" : ""}`;

            return (
              <TableRow
                key={row.id}
                data-row-id={row.id}
                data-method={row.method}
                data-outcome={row.outcome}
                data-new={isNew ? "true" : undefined}
                className={cn(isNew && "activity-row-new")}
              >
                <TableCell className="align-top font-data text-muted-foreground">
                  <span title={isoTime}>{timeLabel}</span>
                </TableCell>
                <TableCell className="align-top">
                  <span
                    role="img"
                    aria-label={lineLabel}
                    title={lineLabel}
                    data-line-code={method.letter}
                    className={cn(
                      "inline-flex size-[22px] items-center justify-center rounded-sm font-data text-xs leading-none font-semibold",
                      row.outcome === "failed"
                        ? "bg-signal text-destructive-foreground"
                        : "bg-rail text-rail-foreground",
                    )}
                  >
                    {method.letter}
                  </span>
                </TableCell>
                <TableCell className="align-top">
                  <span className="block max-w-[28ch] truncate font-medium" title={row.who}>
                    {row.who}
                  </span>
                  {row.whoSub ? (
                    <span className="block max-w-[28ch] truncate text-xs text-muted-foreground" title={row.whoSub}>
                      {row.whoSub}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="hidden max-w-[30ch] truncate align-top text-muted-foreground sm:table-cell">
                  {row.where ?? ""}
                </TableCell>
                <TableCell className="align-top">
                  <span className="inline-flex items-center gap-1.5">
                    <span className={cn("size-1.5 shrink-0 rounded-full", outcome.dot)} aria-hidden="true" />
                    <span className="font-medium">{outcome.label}</span>
                  </span>
                  {row.detail ? (
                    <span className="mt-0.5 block max-w-[30ch] truncate text-xs text-muted-foreground" title={row.detail}>
                      {row.detail}
                    </span>
                  ) : null}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
