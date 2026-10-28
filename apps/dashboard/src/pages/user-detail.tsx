import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Card, CardContent, Separator, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from "@orbitid/ui";
import { ArrowLeft, Loader2, UserRound } from "lucide-react";
import type { UserJSON } from "@orbitid/shared";
import { useApi } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { primaryEmail, userLabel } from "../lib/format";
import { useImpersonate } from "../lib/impersonation";
import { PageHeader } from "../components/shared/page-header";
import { StatusBadge } from "../components/shared/status-badge";
import { UserAvatar } from "../components/shared/user-avatar";
import { EmptyState } from "../components/shared/empty-state";
import { UserRowActions } from "../components/users/user-row-actions";
import { UserProfileTab } from "../components/users/user-profile-tab";
import { UserIdentifiersTab } from "../components/users/user-identifiers-tab";
import { UserSecurityTab } from "../components/users/user-security-tab";
import { UserSessionsTab } from "../components/users/user-sessions-tab";
import { UserOrganizationsTab } from "../components/users/user-organizations-tab";
import { UserMetadataTab } from "../components/users/user-metadata-tab";
import { UserActivityTab } from "../components/users/user-activity-tab";
import { UserDangerTab } from "../components/users/user-danger-tab";

const TABS = [
  { value: "profile", label: "Profile" },
  { value: "identifiers", label: "Identifiers" },
  { value: "security", label: "Security" },
  { value: "sessions", label: "Sessions" },
  { value: "organizations", label: "Organizations" },
  { value: "metadata", label: "Metadata" },
  { value: "activity", label: "Activity" },
  { value: "danger", label: "Danger zone" },
] as const;

type TabValue = (typeof TABS)[number]["value"];

export default function UserDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const impersonate = useImpersonate();

  const tabParam = searchParams.get("tab") as TabValue | null;
  const tab: TabValue = TABS.some((entry) => entry.value === tabParam) ? (tabParam as TabValue) : "profile";

  const userQuery = useApi<UserJSON>(["user", id], `/users/${id}`, { enabled: !!id });
  const user = userQuery.data;

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ["user", id] });
    void queryClient.invalidateQueries({ queryKey: ["users"] });
    void queryClient.invalidateQueries({ queryKey: ["user-sessions"] });
    void queryClient.invalidateQueries({ queryKey: ["user-memberships", id] });
    void queryClient.invalidateQueries({ queryKey: ["user-activity"] });
  }

  function setTab(value: string) {
    const next = new URLSearchParams(searchParams);
    if (value === "profile") next.delete("tab");
    else next.set("tab", value);
    setSearchParams(next, { replace: true });
  }

  if (userQuery.error) {
    return (
      <Card>
        <CardContent className="py-4">
          <EmptyState
            icon={UserRound}
            title="Could not load this user"
            description={errorMessage(userQuery.error)}
            action={
              <Button variant="outline" size="sm" onClick={() => navigate("/users")}>
                <ArrowLeft aria-hidden /> Back to users
              </Button>
            }
          />
        </CardContent>
      </Card>
    );
  }

  if (!user) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-10 w-full max-w-xl" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {userLabel(user)}
            {user.banned ? <StatusBadge status="banned" /> : null}
            {user.locked ? <StatusBadge status="locked" /> : null}
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>{primaryEmail(user) || "No email address"}</span>
            <span aria-hidden>·</span>
            <code className="font-mono text-xs">{user.id}</code>
          </span>
        }
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void impersonate.impersonate(user.id)}
              disabled={impersonate.pending}
            >
              {impersonate.pending ? <Loader2 className="animate-spin" aria-hidden /> : <UserRound aria-hidden />}
              Impersonate
            </Button>
            <UserRowActions user={user} onDeleted={() => navigate("/users", { replace: true })} />
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-4 py-3">
        <UserAvatar name={userLabel(user)} imageUrl={user.image_url} size="lg" />
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline">{user.username ? `@${user.username}` : "No username"}</Badge>
            <Badge variant="outline">{user.email_addresses.length} email(s)</Badge>
            <Badge variant="outline">{user.phone_numbers.length} phone(s)</Badge>
            <Badge variant="outline">{user.passkeys.length} passkey(s)</Badge>
            <Badge variant="outline">{user.external_accounts.length} social</Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            External ID: <code>{user.external_id ?? "—"}</code>
          </p>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <div className="overflow-x-auto pb-1">
          <TabsList>
            {TABS.map((entry) => (
              <TabsTrigger key={entry.value} value={entry.value}>
                {entry.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <Separator className="my-4" />

        <TabsContent value="profile">
          <UserProfileTab key={`profile-${user.updated_at}`} user={user} onUpdated={refresh} />
        </TabsContent>
        <TabsContent value="identifiers">
          <UserIdentifiersTab user={user} onUpdated={refresh} />
        </TabsContent>
        <TabsContent value="security">
          <UserSecurityTab user={user} onUpdated={refresh} />
        </TabsContent>
        <TabsContent value="sessions">
          <UserSessionsTab user={user} onUpdated={refresh} />
        </TabsContent>
        <TabsContent value="organizations">
          <UserOrganizationsTab user={user} onUpdated={refresh} />
        </TabsContent>
        <TabsContent value="metadata">
          <UserMetadataTab key={`metadata-${user.updated_at}`} user={user} onUpdated={refresh} />
        </TabsContent>
        <TabsContent value="activity">
          <UserActivityTab user={user} />
        </TabsContent>
        <TabsContent value="danger">
          <UserDangerTab user={user} onDeleted={() => navigate("/users", { replace: true })} />
        </TabsContent>
      </Tabs>
    </>
  );
}
