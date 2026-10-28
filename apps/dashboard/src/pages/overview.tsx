import { Link } from "react-router-dom";
import { ActivityBoard, Button, Skeleton } from "@orbitid/ui";
import { RefreshCw, Users } from "lucide-react";
import type { SessionJSON, UserJSON } from "@orbitid/shared";
import { useApi } from "../lib/api";
import { useHealth, useInstance } from "../lib/instance";
import type { InstanceStatsJSON } from "../lib/types";
import { errorMessage } from "../lib/errors";
import { formatNumber, primaryEmail, userLabel } from "../lib/format";
import { sessionActivityRows } from "../lib/activity";
import { PageHeader } from "../components/shared/page-header";
import { Section } from "../components/shared/section";
import { UserAvatar } from "../components/shared/user-avatar";
import { EmptyState } from "../components/shared/empty-state";
import { TimeAgo } from "../components/shared/time-ago";
import { InstanceSheet } from "../components/overview/instance-sheet";
import { TrendChart } from "../components/overview/trend-chart";
import { InstanceKeys } from "../components/overview/instance-keys";

const sumCounts = (series: { count: number }[] | undefined) => (series ?? []).reduce((total, point) => total + point.count, 0);

export default function OverviewPage() {
  const stats = useApi<InstanceStatsJSON>(["stats"], "/stats", { refetchInterval: 30_000 });
  const health = useHealth();
  const instance = useInstance();
  const recentUsers = useApi<{ data: UserJSON[] }>(["users", "recent"], "/users?limit=5&order_by=-created_at&paginated=true");
  const recentSessions = useApi<{ data: SessionJSON[] }>(
    ["sessions", "recent"],
    "/sessions?limit=20&order_by=-created_at",
    { refetchInterval: 15_000 },
  );

  const data = stats.data;
  const providers = data?.top_social_providers ?? [];
  const users = recentUsers.data?.data ?? [];
  const activity = sessionActivityRows(recentSessions.data?.data);
  const signIns30d = sumCounts(data?.signins_by_day);

  return (
    <>
      <PageHeader
        title="Overview"
        description="What this instance holds right now, and the sign-ins that just happened."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void stats.refetch();
              void health.refetch();
              void recentUsers.refetch();
              void recentSessions.refetch();
            }}
            disabled={stats.isFetching}
          >
            <RefreshCw className={stats.isFetching ? "animate-spin" : undefined} aria-hidden /> Refresh
          </Button>
        }
      />

      {stats.error ? (
        <div role="alert" className="flex flex-col gap-1 border border-signal/40 bg-signal/5 px-3 py-2.5 text-sm">
          <p className="font-medium">Could not load instance statistics</p>
          <p className="text-muted-foreground">
            {errorMessage(stats.error)} Check that the server answers at the frontend API URL, then refresh.
          </p>
        </div>
      ) : null}

      <InstanceSheet stats={data} loading={stats.isLoading} />

      <Section
        title="Recent sign-ins"
        description="Newest sessions on this instance, refreshed every 15 seconds."
        actions={
          <Button variant="ghost" size="sm" asChild>
            <Link to="/sessions">All sessions</Link>
          </Button>
        }
        className="border-t-0 pt-0"
      >
        {recentSessions.isLoading || activity.length > 0 ? (
          <div className="overflow-hidden rounded-[4px] border border-border">
            <ActivityBoard
              rows={activity}
              loading={recentSessions.isLoading}
              maxRows={20}
              emptyTitle="No sign-ins yet"
              emptyHint="Create a user or open the test site. Every new session lands here."
            />
          </div>
        ) : (
          <ActivityBoard
            rows={activity}
            emptyTitle="No sign-ins yet"
            emptyHint="Create a user or open the test site. Every new session lands here."
          />
        )}
        {recentSessions.error ? (
          <p role="alert" className="mt-2 text-sm leading-6 text-muted-foreground">
            Could not read sessions: {errorMessage(recentSessions.error)} Reload the page once the server is reachable.
          </p>
        ) : null}
        <p className="mt-2 max-w-[90ch] text-xs leading-5 text-muted-foreground">
          The line code is the method each session was created with. Sessions created before this was recorded show <span className="font-data">?</span>.
        </p>
      </Section>

      <div className="grid gap-8 lg:grid-cols-3">
        <Section
          title="Last 30 days"
          description="New accounts and new sessions per day, from the instance statistics."
          className="lg:col-span-2"
        >
          <div className="space-y-5">
            <div>
              <div className="flex items-baseline gap-2">
                <h3 className="text-[0.8125rem] font-semibold text-foreground">Sign-ups per day</h3>
                <span className="font-data text-xs text-muted-foreground">
                  {formatNumber(sumCounts(data?.signups_by_day))} in 30 days
                </span>
              </div>
              {stats.isLoading ? (
                <Skeleton className="mt-2 h-[180px] w-full" />
              ) : (
                <TrendChart data={data?.signups_by_day ?? []} tone="ink" label="Sign-ups" />
              )}
            </div>
            <div>
              <div className="flex items-baseline gap-2">
                <h3 className="text-[0.8125rem] font-semibold text-foreground">Sign-ins per day</h3>
                <span className="font-data text-xs text-muted-foreground">{formatNumber(signIns30d)} in 30 days</span>
              </div>
              {stats.isLoading ? (
                <Skeleton className="mt-2 h-[180px] w-full" />
              ) : (
                <TrendChart data={data?.signins_by_day ?? []} tone="signal" label="Sign-ins" />
              )}
            </div>
          </div>
        </Section>

        <div className="space-y-8">
          <Section
            title="Newest accounts"
            actions={
              <Button variant="ghost" size="sm" asChild>
                <Link to="/users">All users</Link>
              </Button>
            }
          >
            {recentUsers.isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, index) => (
                  <Skeleton key={index} className="h-9 w-full" />
                ))}
              </div>
            ) : users.length === 0 ? (
              <EmptyState
                icon={Users}
                title="No users yet"
                description="Create the first user, or let someone sign up from your app."
                action={
                  <Button size="sm" asChild>
                    <Link to="/users?create=1">Create user</Link>
                  </Button>
                }
              />
            ) : (
              <ul className="-mx-2 divide-y divide-border">
                {users.map((user) => (
                  <li key={user.id}>
                    <Link
                      to={`/users/${user.id}`}
                      className="-mx-2 flex items-center gap-2.5 rounded-[3px] px-2 py-2 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <UserAvatar name={userLabel(user)} imageUrl={user.image_url} size="sm" />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm font-medium">{userLabel(user)}</span>
                        <span className="truncate font-mono text-[0.6875rem] text-muted-foreground">
                          {primaryEmail(user) || user.id}
                        </span>
                      </span>
                      <TimeAgo value={user.created_at} className="text-xs text-muted-foreground" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Social providers" description="Connected external accounts.">
            {providers.length === 0 ? (
              <p className="text-sm leading-6 text-muted-foreground">
                No external accounts yet. Enable a provider under Settings, Social.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {providers.map((provider) => (
                  <li key={provider.provider} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <span className="capitalize">{provider.provider.replace(/_/g, " ")}</span>
                    <span className="font-mono text-xs tabular-nums text-muted-foreground">
                      {formatNumber(provider.count)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>

      <InstanceKeys health={health.data} healthError={health.error} instance={instance.data} loading={health.isLoading} />
    </>
  );
}
