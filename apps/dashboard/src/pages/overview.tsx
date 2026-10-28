import { Link } from "react-router-dom";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Progress,
  Skeleton,
} from "@orbitid/ui";
import {
  Activity,
  Ban,
  Building2,
  Clock,
  Lock,
  MonitorSmartphone,
  RefreshCw,
  ShieldCheck,
  Users,
} from "lucide-react";
import type { UserJSON } from "@orbitid/shared";
import { useApi } from "../lib/api";
import { useHealth, useInstance } from "../lib/instance";
import type { InstanceStatsJSON } from "../lib/types";
import { errorMessage } from "../lib/errors";
import { formatNumber, percent, primaryEmail, userLabel } from "../lib/format";
import { PageHeader } from "../components/shared/page-header";
import { UserAvatar } from "../components/shared/user-avatar";
import { EmptyState } from "../components/shared/empty-state";
import { TimeAgo } from "../components/shared/time-ago";
import { StatCard } from "../components/overview/stat-card";
import { TrendChart } from "../components/overview/trend-chart";
import { InstanceKeys } from "../components/overview/instance-keys";

const sumCounts = (series: { count: number }[] | undefined) => (series ?? []).reduce((total, point) => total + point.count, 0);

export default function OverviewPage() {
  const stats = useApi<InstanceStatsJSON>(["stats"], "/stats", { refetchInterval: 30_000 });
  const health = useHealth();
  const instance = useInstance();
  const recentUsers = useApi<{ data: UserJSON[] }>(["users", "recent"], "/users?limit=5&order_by=-created_at");

  const data = stats.data;
  const mfaAdoption = data ? percent(data.mfa_enabled_users, data.users_total) : "—";
  const providers = data?.top_social_providers ?? [];
  const maxProviderCount = Math.max(1, ...providers.map((provider) => provider.count));
  const users = recentUsers.data?.data ?? [];

  return (
    <>
      <PageHeader
        title="Overview"
        description="Instance health, sign-up trends and the most recent accounts."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void stats.refetch();
              void health.refetch();
              void recentUsers.refetch();
            }}
            disabled={stats.isFetching}
          >
            <RefreshCw className={stats.isFetching ? "animate-spin" : undefined} aria-hidden /> Refresh
          </Button>
        }
      />

      {stats.error ? (
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm">
          <p className="font-medium text-destructive">Could not load instance statistics</p>
          <p className="text-muted-foreground">{errorMessage(stats.error)}</p>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="Users"
          value={formatNumber(data?.users_total)}
          hint={`${formatNumber(data?.users_active_7d)} active in the last 7 days`}
          icon={Users}
          loading={stats.isLoading}
        />
        <StatCard
          title="Active sessions"
          value={formatNumber(data?.sessions_active)}
          hint="Unexpired, status active"
          icon={MonitorSmartphone}
          loading={stats.isLoading}
        />
        <StatCard
          title="Organizations"
          value={formatNumber(data?.organizations_total)}
          hint="Across the whole instance"
          icon={Building2}
          loading={stats.isLoading}
        />
        <StatCard
          title="MFA adoption"
          value={mfaAdoption}
          hint={`${formatNumber(data?.mfa_enabled_users)} users with a second factor`}
          icon={ShieldCheck}
          loading={stats.isLoading}
        />
      </div>

      <div className="flex flex-wrap items-center gap-x-8 gap-y-3 rounded-lg border bg-card px-4 py-3 text-sm">
        <span className="flex items-center gap-2">
          <Ban className="size-4 text-muted-foreground" aria-hidden />
          <span className="text-muted-foreground">Banned</span>
          <span className="font-medium tabular-nums">{formatNumber(data?.banned_users)}</span>
        </span>
        <span className="flex items-center gap-2">
          <Lock className="size-4 text-muted-foreground" aria-hidden />
          <span className="text-muted-foreground">Locked</span>
          <span className="font-medium tabular-nums">{formatNumber(data?.locked_users)}</span>
        </span>
        <span className="flex items-center gap-2">
          <Activity className="size-4 text-muted-foreground" aria-hidden />
          <span className="text-muted-foreground">Sign-ups (30d)</span>
          <span className="font-medium tabular-nums">{formatNumber(sumCounts(data?.signups_by_day))}</span>
        </span>
        <span className="flex items-center gap-2">
          <Clock className="size-4 text-muted-foreground" aria-hidden />
          <span className="text-muted-foreground">Sign-ins (30d)</span>
          <span className="font-medium tabular-nums">{formatNumber(sumCounts(data?.signins_by_day))}</span>
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Sign-ups</CardTitle>
            <CardDescription>New users per day over the last 30 days</CardDescription>
          </CardHeader>
          <CardContent>
            <TrendChart data={data?.signups_by_day ?? []} kind="area" color="var(--chart-1)" label="Sign-ups" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Sign-ins</CardTitle>
            <CardDescription>New sessions per day over the last 30 days</CardDescription>
          </CardHeader>
          <CardContent>
            <TrendChart data={data?.signins_by_day ?? []} kind="bar" color="var(--chart-2)" label="Sign-ins" />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between gap-2">
            <div className="space-y-1">
              <CardTitle>Recent users</CardTitle>
              <CardDescription>The five newest accounts</CardDescription>
            </div>
            <Button variant="ghost" size="sm" asChild>
              <Link to="/users">View all</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {recentUsers.isLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 5 }).map((_, index) => (
                  <Skeleton key={index} className="h-10 w-full" />
                ))}
              </div>
            ) : users.length === 0 ? (
              <EmptyState icon={Users} title="No users yet" description="Sign-ups will appear here as soon as your app is live." />
            ) : (
              <ul className="divide-y">
                {users.map((user) => (
                  <li key={user.id}>
                    <Link
                      to={`/users/${user.id}`}
                      className="-mx-2 flex items-center gap-3 rounded-md px-2 py-2.5 hover:bg-accent/60"
                    >
                      <UserAvatar name={userLabel(user)} imageUrl={user.image_url} size="sm" />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm font-medium">{userLabel(user)}</span>
                        <span className="truncate text-xs text-muted-foreground">{primaryEmail(user) || user.id}</span>
                      </span>
                      <TimeAgo value={user.created_at} className="text-xs text-muted-foreground" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Top social providers</CardTitle>
            <CardDescription>Connected external accounts</CardDescription>
          </CardHeader>
          <CardContent>
            {providers.length === 0 ? (
              <EmptyState icon={Building2} title="No social accounts" description="OAuth connections will be counted here." />
            ) : (
              <ul className="space-y-3">
                {providers.map((provider) => (
                  <li key={provider.provider} className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2 text-sm">
                      <span className="capitalize">{provider.provider.replace(/_/g, " ")}</span>
                      <Badge variant="secondary" className="tabular-nums">
                        {formatNumber(provider.count)}
                      </Badge>
                    </div>
                    <Progress value={(provider.count / maxProviderCount) * 100} className="h-1.5" />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <InstanceKeys
        health={health.data}
        healthError={health.error}
        instance={instance.data}
        loading={health.isLoading}
      />
    </>
  );
}
