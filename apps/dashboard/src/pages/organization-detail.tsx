import { useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Card, CardContent, Separator, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from "@orbitid/ui";
import { Building2, ExternalLink } from "lucide-react";
import type { OrganizationJSON } from "@orbitid/shared";
import { useApi } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { formatNumber } from "../lib/format";
import { PageHeader } from "../components/shared/page-header";
import { UserAvatar } from "../components/shared/user-avatar";
import { EmptyState } from "../components/shared/empty-state";
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
  }

  function setTab(value: string) {
    const next = new URLSearchParams(searchParams);
    if (value === "members") next.delete("tab");
    else next.set("tab", value);
    setSearchParams(next, { replace: true });
  }

  if (orgQuery.error) {
    return (
      <Card>
        <CardContent className="py-4">
          <EmptyState icon={Building2} title="Could not load this organization" description={errorMessage(orgQuery.error)} />
        </CardContent>
      </Card>
    );
  }

  if (!org) {
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
        title={org.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <code className="font-mono text-xs">{org.slug}</code>
            <span aria-hidden>·</span>
            <span>{formatNumber(org.members_count ?? 0)} members</span>
            <span aria-hidden>·</span>
            <span>{formatNumber(org.pending_invitations_count ?? 0)} pending invitations</span>
          </span>
        }
        actions={
          <Button variant="outline" size="sm" onClick={() => setTab("settings")}>
            <ExternalLink aria-hidden /> Settings
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-4 py-3">
        <UserAvatar name={org.name} imageUrl={org.image_url} size="lg" />
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline">Max {formatNumber(org.max_allowed_memberships)} members</Badge>
          <Badge variant="outline">{org.admin_delete_enabled ? "Admins can delete" : "Deletion restricted"}</Badge>
          <Badge variant="outline">Created {new Date(org.created_at).toLocaleDateString()}</Badge>
          {org.created_by ? <Badge variant="outline">Created by {org.created_by}</Badge> : null}
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
