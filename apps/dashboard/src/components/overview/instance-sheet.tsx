import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import type { DailyCount, InstanceStatsJSON } from "../../lib/types";
import { formatNumber, percent } from "../../lib/format";

/** Sum of the last seven days of a daily series against the seven before it. */
export function weeklyDelta(series: DailyCount[] | undefined): number | null {
  const points = (series ?? []).slice().sort((a, b) => a.date.localeCompare(b.date));
  if (points.length < 8) return null;
  const recent = points.slice(-7).reduce((total, point) => total + point.count, 0);
  const previous = points.slice(-14, -7).reduce((total, point) => total + point.count, 0);
  return recent - previous;
}

function Delta({ value, label }: { value: number | null; label: string }) {
  if (value === null) return <p className="text-xs leading-5 text-muted-foreground">{label}</p>;
  if (value === 0) return <p className="text-xs leading-5 text-muted-foreground">No change vs previous 7 days</p>;
  const Icon = value > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <p className="flex items-center gap-1 text-xs leading-5 text-muted-foreground">
      {/* The arrow and the printed sign carry the direction; colour is a second cue only. */}
      <Icon className={value > 0 ? "size-3 text-go" : "size-3 text-signal"} strokeWidth={1.5} aria-hidden />
      <span className="tabular-nums text-foreground">{value > 0 ? `+${formatNumber(value)}` : formatNumber(value)}</span>
      <span>vs previous 7 days</span>
    </p>
  );
}

function Cell({
  label,
  value,
  note,
  loading,
}: {
  label: string;
  value: string;
  note: ReactNode;
  loading: boolean;
}) {
  return (
    <div className="min-w-0 border-b border-border px-4 py-4 lg:border-b-0">
      <dt className="text-[0.75rem] font-semibold uppercase tracking-[0.04em] text-muted-foreground">{label}</dt>
      <dd className="mt-1.5 text-[1.75rem] font-[650] leading-none tracking-[-0.02em] tabular-nums text-foreground">
        {loading ? <span className="inline-block h-6 w-14 animate-pulse rounded-[2px] bg-muted align-middle" /> : value}
      </dd>
      <dd className="mt-1.5">{note}</dd>
    </div>
  );
}

/**
 * The instance sheet: every headline number on one ruled strip, aligned figures, no cards.
 * Figures come from `GET /stats`; the block counts come from the same payload.
 */
export function InstanceSheet({ stats, loading }: { stats: InstanceStatsJSON | undefined; loading: boolean }) {
  const signUps30d = (stats?.signups_by_day ?? []).reduce((total, point) => total + point.count, 0);
  const signIns30d = (stats?.signins_by_day ?? []).reduce((total, point) => total + point.count, 0);

  return (
    <div className="border-y border-border">
      <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
        <Cell
          label="Users"
          loading={loading}
          value={formatNumber(stats?.users_total)}
          note={
            <p className="text-xs leading-5 text-muted-foreground">
              <span className="tabular-nums">{formatNumber(stats?.users_active_7d)}</span> active in the last 7 days
            </p>
          }
        />
        <Cell
          label="Active sessions"
          loading={loading}
          value={formatNumber(stats?.sessions_active)}
          note={<p className="text-xs leading-5 text-muted-foreground">Unexpired, status active</p>}
        />
        <Cell
          label="Organizations"
          loading={loading}
          value={formatNumber(stats?.organizations_total)}
          note={<p className="text-xs leading-5 text-muted-foreground">Across the whole instance</p>}
        />
        <Cell
          label="MFA adoption"
          loading={loading}
          value={stats ? percent(stats.mfa_enabled_users, stats.users_total) : "—"}
          note={
            <p className="text-xs leading-5 text-muted-foreground">
              <span className="tabular-nums">{formatNumber(stats?.mfa_enabled_users)}</span> users with a second factor
            </p>
          }
        />
        <Cell
          label="Sign-ups (30d)"
          loading={loading}
          value={formatNumber(signUps30d)}
          note={<Delta value={weeklyDelta(stats?.signups_by_day)} label="New accounts per day, last 30 days" />}
        />
        <Cell
          label="Sign-ins (30d)"
          loading={loading}
          value={formatNumber(signIns30d)}
          note={<Delta value={weeklyDelta(stats?.signins_by_day)} label="New sessions per day, last 30 days" />}
        />
      </dl>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
        <span className="font-semibold uppercase tracking-[0.04em]">Blocked accounts</span>
        <span className="flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-signal" aria-hidden />
          Banned <span className="tabular-nums text-foreground">{formatNumber(stats?.banned_users)}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-caution" aria-hidden />
          Locked <span className="tabular-nums text-foreground">{formatNumber(stats?.locked_users)}</span>
        </span>
        <Link
          to="/audit-logs"
          className="ml-auto underline decoration-border underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          Audit log
        </Link>
      </div>
    </div>
  );
}
