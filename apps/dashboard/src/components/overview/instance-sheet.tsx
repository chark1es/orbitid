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
    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs leading-5 text-muted-foreground">
      {/* The arrow and the number are one unit; on a phone the label moves below instead of splitting it. */}
      <span className="inline-flex items-center gap-1 whitespace-nowrap">
        <Icon className={value > 0 ? "size-4 text-go" : "size-4 text-signal"} aria-hidden />
        <span className="tabular-nums text-foreground">{value > 0 ? `+${formatNumber(value)}` : formatNumber(value)}</span>
      </span>
      <span className="whitespace-nowrap">vs previous 7 days</span>
    </p>
  );
}

function CountRow({
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
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-2.5">
      <dt className="w-40 shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium tabular-nums text-foreground">
        {loading ? <span className="inline-block h-3.5 w-10 animate-pulse rounded-[3px] bg-muted align-middle" /> : value}
      </dd>
      <dd className="min-w-0 flex-1 text-xs leading-5 text-muted-foreground">{note}</dd>
    </div>
  );
}

/**
 * The instance sheet: counts set as ruled rows at body size. Real numbers, no hero figures and no
 * grid of identical cards. Figures come from `GET /stats`; the block counts come from the same payload.
 */
export function InstanceSheet({ stats, loading }: { stats: InstanceStatsJSON | undefined; loading: boolean }) {
  const signUps30d = (stats?.signups_by_day ?? []).reduce((total, point) => total + point.count, 0);
  const signIns30d = (stats?.signins_by_day ?? []).reduce((total, point) => total + point.count, 0);
  const banned = stats?.banned_users ?? 0;
  const locked = stats?.locked_users ?? 0;

  return (
    <div className="border-y border-border">
      <dl className="divide-y divide-border">
        <CountRow
          label="Users"
          loading={loading}
          value={formatNumber(stats?.users_total)}
          note={
            <>
              <span className="tabular-nums">{formatNumber(stats?.users_active_7d)}</span> active in the last 7 days
            </>
          }
        />
        <CountRow
          label="Active sessions"
          loading={loading}
          value={formatNumber(stats?.sessions_active)}
          note="Unexpired, status active"
        />
        <CountRow
          label="Organizations"
          loading={loading}
          value={formatNumber(stats?.organizations_total)}
          note="Across the whole instance"
        />
        <CountRow
          label="MFA adoption"
          loading={loading}
          value={stats ? percent(stats.mfa_enabled_users, stats.users_total) : "—"}
          note={
            <>
              <span className="tabular-nums">{formatNumber(stats?.mfa_enabled_users)}</span> users with a second factor
            </>
          }
        />
        <CountRow
          label="Sign-ups (30d)"
          loading={loading}
          value={formatNumber(signUps30d)}
          note={<Delta value={weeklyDelta(stats?.signups_by_day)} label="New accounts per day, last 30 days" />}
        />
        <CountRow
          label="Sign-ins (30d)"
          loading={loading}
          value={formatNumber(signIns30d)}
          note={<Delta value={weeklyDelta(stats?.signins_by_day)} label="New sessions per day, last 30 days" />}
        />
      </dl>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
        <span className="text-sm font-medium text-foreground">Blocked accounts</span>
        <span className="flex items-center gap-1.5">
          {banned > 0 ? <span className="size-1.5 rounded-full bg-signal" aria-hidden /> : null}
          Banned <span className="tabular-nums text-foreground">{formatNumber(stats?.banned_users)}</span>
        </span>
        <span className="flex items-center gap-1.5">
          {locked > 0 ? <span className="size-1.5 rounded-full bg-caution" aria-hidden /> : null}
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
