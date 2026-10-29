import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Skeleton, Tabs, TabsContent } from "@orbitid/ui";
import { ArrowLeft, Building2, Settings2 } from "lucide-react";
import type { OrganizationJSON } from "@orbitid/shared";
import { useApi } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { formatNumber } from "../lib/format";
import { UserAvatar } from "../components/shared/user-avatar";
import { EmptyState } from "../components/shared/empty-state";
import { CopyButton } from "../components/shared/copy-button";
import { TabStrip } from "../components/shared/tab-strip";
import { OrganizationMembersTab } from "../components/organizations/organization-members-tab";
import { OrganizationInvitationsTab } from "../components/organizations/organization-invitations-tab";
import { OrganizationDomainsTab } from "../components/organizations/organization-domains-tab";
import { OrganizationMetadataTab } from "../components/organizations/organization-metadata-tab";
import { OrganizationSettingsTab } from "../components/organizations/organization-settings-tab";

const TABS = [
  { value: "members", label: "Members" },
  { value: "invitations", label: "Invitations" },
  { value: "domains", label: "Domains" },
  { value: "metadata", label: "Metadata" },
  { value: "settings", label: "Settings" },
] as const;

type TabValue = (typeof TABS)[number]["value"];

export default function OrganizationDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const tabParam = searchParams.get("tab");
  const tab: TabValue = TABS.some((entry) => entry.value === tabParam) ? (tabParam as TabValue) : "members";

  const orgQuery = useApi<OrganizationJSON>(["organization", id], `/organizations/${id}`, { enabled: !!id });
  const org = orgQuery.data;

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ["organization", id] });
    void queryClient.invalidateQueries({ queryKey: ["organizations"] });
    void queryClient.invalidateQueries({ queryKey: ["organization-members", id] });
    void queryClient.invalidateQueries({ queryKey: ["organization-invitations", id] });
    void queryClient.invalidateQueries({ queryKey: ["organization-domains", id] });
  }

  function setTab(value: string) {
    const next = new URLSearchParams(searchParams);
    if (value === "members") next.delete("tab");
    else next.set("tab", value);
    setSearchParams(next, { replace: true });
  }

  if (orgQuery.error) {
    return (
      <div className="border border-border bg-card">
        <EmptyState
          icon={Building2}
          title="Could not load this organization"
          description={`${errorMessage(orgQuery.error)} It may have been deleted. Go back to the list and refresh.`}
          action={
            <Button variant="outline" size="sm" asChild>
              <Link to="/organizations">
                <ArrowLeft aria-hidden /> Back to organizations
              </Link>
            </Button>
          }
        />
      </div>
    );
  }

  if (!org) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-4 w-32" />
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
          to="/organizations"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <ArrowLeft className="size-3.5" strokeWidth={1.5} aria-hidden /> Organizations
        </Link>
      </div>

      <header className="flex flex-col gap-4 border-b border-border pb-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <UserAvatar name={org.name} imageUrl={org.image_url} size="lg" />
          <div className="min-w-0 space-y-1.5">
            <h1 className="text-[1.375rem] font-[650] leading-tight tracking-[-0.015em]">{org.name}</h1>
            <div className="flex items-center gap-1">
              <code className="font-data text-[0.8125rem] text-muted-foreground">{org.slug}</code>
              <CopyButton value={org.slug} label="Copy slug" size="icon-xs" />
            </div>
            <dl className="flex flex-wrap items-center gap-y-1 pt-1 text-xs text-muted-foreground [&_dt]:text-[0.6875rem] [&_dt]:uppercase [&_dt]:tracking-[0.04em]">
              <div className="flex items-center gap-1.5 border-l border-border pl-3 first:border-l-0 first:pl-0">
                <dt>Members</dt>
                <dd className="font-data text-foreground">{formatNumber(org.members_count ?? 0)}</dd>
              </div>
              <div className="flex items-center gap-1.5 border-l border-border pl-3">
                <dt>Pending invitations</dt>
                <dd className="font-data text-foreground">{formatNumber(org.pending_invitations_count ?? 0)}</dd>
              </div>
              <div className="flex items-center gap-1.5 border-l border-border pl-3">
                <dt>Member limit</dt>
                <dd className="font-data text-foreground">{formatNumber(org.max_allowed_memberships)}</dd>
              </div>
              <div className="flex items-center gap-1.5 border-l border-border pl-3">
                <dt>Created</dt>
                <dd className="font-data text-foreground">{new Date(org.created_at).toLocaleDateString()}</dd>
              </div>
              <div className="flex items-center gap-1.5 border-l border-border pl-3">
                <dt>Deletion</dt>
                <dd className="text-foreground">{org.admin_delete_enabled ? "Admins can delete" : "Restricted"}</dd>
              </div>
              {org.created_by ? (
                <div className="flex items-center gap-1.5 border-l border-border pl-3">
                  <dt>Created by</dt>
                  <dd className="font-data text-foreground">{org.created_by}</dd>
                </div>
              ) : null}
            </dl>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setTab("settings")}>
            <Settings2 aria-hidden /> Settings
          </Button>
        </div>
      </header>

      <Tabs value={tab} onValueChange={setTab}>
        <TabStrip tabs={TABS} />

        <TabsContent value="members">
          <OrganizationMembersTab org={org} onChanged={refresh} />
        </TabsContent>
        <TabsContent value="invitations">
          <OrganizationInvitationsTab org={org} onChanged={refresh} />
        </TabsContent>
        <TabsContent value="domains">
          <OrganizationDomainsTab org={org} onChanged={refresh} />
        </TabsContent>
        <TabsContent value="metadata">
          <OrganizationMetadataTab key={`metadata-${org.updated_at}`} org={org} onChanged={refresh} />
        </TabsContent>
        <TabsContent value="settings">
          <OrganizationSettingsTab key={`settings-${org.updated_at}`} org={org} onChanged={refresh} />
        </TabsContent>
      </Tabs>
    </>
  );
}
