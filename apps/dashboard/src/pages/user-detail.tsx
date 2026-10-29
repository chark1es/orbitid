import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Skeleton, Tabs, TabsContent } from "@orbitid/ui";
import { ArrowLeft, Ghost, Loader2, UserRound } from "lucide-react";
import type { UserJSON } from "@orbitid/shared";
import { useApi } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { primaryEmail, userLabel } from "../lib/format";
import { useImpersonate } from "../lib/impersonation";
import { StatusBadge } from "../components/shared/status-badge";
import { UserAvatar } from "../components/shared/user-avatar";
import { EmptyState } from "../components/shared/empty-state";
import { CopyButton } from "../components/shared/copy-button";
import { ConfirmDialog } from "../components/shared/confirm-dialog";
import { TabStrip } from "../components/shared/tab-strip";
import { UserRowActions } from "../components/users/user-row-actions";
import { UserProfileTab } from "../components/users/user-profile-tab";
import { UserIdentifiersTab } from "../components/users/user-identifiers-tab";
import { UserSecurityTab } from "../components/users/user-security-tab";
import { UserSessionsTab } from "../components/users/user-sessions-tab";
import { UserTrustedDevices } from "../components/users/user-trusted-devices";
import { UserOrganizationsTab } from "../components/users/user-organizations-tab";
import { UserMetadataTab } from "../components/users/user-metadata-tab";
import { UserActivityTab } from "../components/users/user-activity-tab";
import { UserDangerTab } from "../components/users/user-danger-tab";

const TABS = [
  { value: "profile", label: "Profile" },
  { value: "identifiers", label: "Identifiers" },
  { value: "security", label: "Security" },
  { value: "sessions", label: "Sessions" },
  { value: "devices", label: "Trusted devices" },
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
  const [confirmImpersonate, setConfirmImpersonate] = useState(false);

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
      <div className="border border-border bg-card">
        <EmptyState
          icon={UserRound}
          title="Could not load this user"
          description={`${errorMessage(userQuery.error)} The user may have been deleted. Reload, or search for them again.`}
          action={
            <Button variant="outline" size="sm" onClick={() => navigate("/users")}>
              <ArrowLeft aria-hidden /> Back to users
            </Button>
          }
        />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-4 w-24" />
        <div className="flex items-center gap-4 border-b border-border pb-4">
          <Skeleton className="size-12" />
          <div className="space-y-2">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-3.5 w-64" />
          </div>
        </div>
        <Skeleton className="h-9 w-full max-w-xl" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <>
      <div>
        <Link
          to="/users"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <ArrowLeft className="size-3.5" strokeWidth={1.5} aria-hidden /> Users
        </Link>
      </div>

      <header className="flex flex-col gap-4 border-b border-border pb-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <UserAvatar name={userLabel(user)} imageUrl={user.image_url} size="lg" />
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-[1.375rem] font-[650] leading-tight tracking-[-0.015em]">{userLabel(user)}</h1>
              {user.banned ? <StatusBadge status="banned" /> : null}
              {user.locked ? <StatusBadge status="locked" /> : null}
              {user.two_factor_enabled ? <StatusBadge status="enabled" label="MFA" /> : null}
              {user.is_anonymous ? <StatusBadge status="guest" tone="info" label="Guest" /> : null}
              {!user.banned && !user.locked && !user.is_anonymous ? <StatusBadge status="active" /> : null}
            </div>
            <p className="font-data text-[0.8125rem] text-muted-foreground">{primaryEmail(user) || "No email address"}</p>
            <div className="flex items-center gap-1">
              <code className="max-w-[46ch] truncate font-data text-[0.75rem] text-muted-foreground">{user.id}</code>
              <CopyButton value={user.id} label="Copy user ID" size="icon-xs" />
            </div>
            <dl className="flex flex-wrap items-center gap-y-1 pt-1 text-xs text-muted-foreground [&_dt]:text-[0.6875rem] [&_dt]:uppercase [&_dt]:tracking-[0.04em]">
              <div className="flex items-center gap-1.5 border-l border-border pl-3 first:border-l-0 first:pl-0">
                <dt>Username</dt>
                <dd className="font-data text-foreground">{user.username ? `@${user.username}` : "none"}</dd>
              </div>
              <div className="flex items-center gap-1.5 border-l border-border pl-3">
                <dt>External ID</dt>
                <dd className="font-data text-foreground">{user.external_id ?? "none"}</dd>
              </div>
              <div className="flex items-center gap-1.5 border-l border-border pl-3">
                <dt>Identifiers</dt>
                <dd className="font-data text-foreground">
                  {user.email_addresses.length} email, {user.phone_numbers.length} phone, {user.passkeys.length} passkey,{" "}
                  {user.external_accounts.length} social
                </dd>
              </div>
            </dl>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmImpersonate(true)}
            disabled={impersonate.pending}
          >
            {impersonate.pending ? <Loader2 className="animate-spin" aria-hidden /> : <UserRound aria-hidden />}
            Impersonate
          </Button>
          <UserRowActions user={user} onDeleted={() => navigate("/users", { replace: true })} />
        </div>
      </header>

      {user.is_anonymous ? (
        <div role="note" className="rounded-[4px] border border-info/35 bg-info/5 px-3 py-2.5">
          <p className="flex items-start gap-2 text-sm font-medium">
            <Ghost className="mt-0.5 size-4 shrink-0 text-info" strokeWidth={1.5} aria-hidden />
            Guest account
          </p>
          <p className="mt-1 max-w-[75ch] text-sm leading-6 text-muted-foreground">
            This account has no verified identifier and no password, so it can only be used from the session it was
            created with. It becomes a registered account the moment it gains a verified email address, a verified phone
            number, a password or a connected account, and keeps its ID, metadata and sessions. Guests cannot create
            organizations or API keys.
          </p>
        </div>
      ) : null}

      <Tabs value={tab} onValueChange={setTab}>
        <TabStrip tabs={TABS} />

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
        <TabsContent value="devices">
          <UserTrustedDevices userId={user.id} />
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

      <ConfirmDialog
        open={confirmImpersonate}
        onOpenChange={setConfirmImpersonate}
        title={`Impersonate ${userLabel(user)}?`}
        description="OrbitID opens your application in a new tab with a session for this user. Your dashboard stays signed in, and their own sessions are untouched."
        confirmLabel="Open as this user"
        onConfirm={() => {
          setConfirmImpersonate(false);
          void impersonate.impersonate(user.id);
        }}
      />
    </>
  );
}
