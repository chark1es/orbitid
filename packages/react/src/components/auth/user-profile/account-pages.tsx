import { useEffect, useState } from "react";
import { Badge, Button, cn } from "@orbitid/ui";
import { ExternalLinkIcon } from "lucide-react";
import { useOrganizationList } from "../../../hooks";
import { safeHttpsUrl } from "../../../lib/profile-pages";
import type { UserOAuthApplicationResource } from "../../../provider/types";
import { OrgAvatar } from "../../org/_shared/OrgAvatar";
import { roleLabel } from "../../org/_shared/utils";
import { useElementClasses } from "../_shared/appearance";
import { useAuthRuntime, type OrbitInstance } from "../_shared/w6";
import { SectionHeader } from "./security-shared";

/** An application on the account page, with the billing link already checked to be https. */
export interface AccountApplication {
  id: string;
  name: string;
  organizationName: string | null;
  access: UserOAuthApplicationResource["access"];
  billingUrl: string | null;
}

export interface UserApplications {
  applications: AccountApplication[];
  /** The list was read (or the SDK cannot read it); pages that depend on it may now decide to show. */
  loaded: boolean;
}

function toAccountApplication(resource: UserOAuthApplicationResource): AccountApplication {
  return {
    id: resource.id,
    name: resource.name,
    organizationName: resource.organization?.name ?? null,
    access: resource.access,
    billingUrl: safeHttpsUrl(resource.billingPortalUrl ?? resource.billing_portal_url),
  };
}

/**
 * The OAuth applications the signed-in user may use (`user.getOAuthApplications()`). A failed read, or an SDK
 * build without the method, is an empty list: the Apps and Billing pages then stay hidden.
 */
export function useUserApplications(orbit: OrbitInstance, userId: string | null): UserApplications {
  const [state, setState] = useState<UserApplications>({ applications: [], loaded: false });
  useEffect(() => {
    let cancelled = false;
    const user = orbit.user;
    const read = user?.getOAuthApplications;
    if (!userId || !user || typeof read !== "function") {
      setState({ applications: [], loaded: true });
      return;
    }
    // A session switch must never show the previous account's applications while the new list loads.
    setState({ applications: [], loaded: false });
    read
      .call(user)
      .then((list) => {
        if (!cancelled) setState({ applications: (Array.isArray(list) ? list : []).map(toAccountApplication), loaded: true });
      })
      .catch(() => {
        if (!cancelled) setState({ applications: [], loaded: true });
      });
    return () => {
      cancelled = true;
    };
  }, [orbit, userId]);
  return state;
}

function BillingLink({ url, label }: { url: string; label: string }) {
  const { el } = useElementClasses();
  return (
    <Button asChild variant="outline" size="sm" className={cn("shrink-0 gap-1.5", el("billingPortalLink"))}>
      <a href={url} target="_blank" rel="noopener noreferrer">
        {label}
        <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
      </a>
    </Button>
  );
}

function EmptyState({ text }: { text: string }) {
  return <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">{text}</p>;
}

/** The organizations the user belongs to, with their role in each. */
export function OrganizationsPage() {
  const { t } = useAuthRuntime();
  const { el } = useElementClasses();
  const { userMemberships } = useOrganizationList({ userMemberships: { pageSize: 50 } });
  const memberships = userMemberships.data;
  return (
    <section className="flex flex-col gap-3" data-orbit-section="organizations">
      <SectionHeader title={t("userProfile.organizations.title")} description={t("userProfile.organizations.description")} />
      {userMemberships.isLoading ? (
        <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
      ) : memberships.length === 0 ? (
        <EmptyState text={t("userProfile.organizations.empty")} />
      ) : (
        <ul className={cn("flex flex-col divide-y rounded-md border", el("organizationList"))}>
          {memberships.map((membership) => (
            <li key={membership.id} className="flex items-center gap-3 px-3 py-2.5">
              <OrgAvatar
                name={membership.organization.name}
                imageUrl={membership.organization.imageUrl}
                hasImage={membership.organization.hasImage}
              />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{membership.organization.name}</span>
              <Badge variant="secondary">{roleLabel(membership.role, membership.roleName, (key) => t(key as never))}</Badge>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function accessLabel(t: ReturnType<typeof useAuthRuntime>["t"], app: AccountApplication): string {
  if (app.access === "instance") return t("userProfile.apps.accessInstance");
  if (app.access === "membership") return t("userProfile.apps.accessMembership", { organization: app.organizationName ?? "" });
  return t("userProfile.apps.accessGrant", { organization: app.organizationName ?? "" });
}

/** The OAuth applications the user may sign in to, and why. */
export function ApplicationsPage({ applications }: { applications: AccountApplication[] }) {
  const { t } = useAuthRuntime();
  const { el } = useElementClasses();
  return (
    <section className="flex flex-col gap-3" data-orbit-section="apps">
      <SectionHeader title={t("userProfile.apps.title")} description={t("userProfile.apps.description")} />
      {applications.length === 0 ? (
        <EmptyState text={t("userProfile.apps.empty")} />
      ) : (
        <ul className={cn("flex flex-col divide-y rounded-md border", el("applicationList"))}>
          {applications.map((app) => (
            <li key={app.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5" data-orbit-application={app.id}>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">{app.name}</span>
                <span className="truncate text-xs text-muted-foreground">{accessLabel(t, app)}</span>
              </div>
              {app.billingUrl ? <BillingLink url={app.billingUrl} label={t("userProfile.billing.manage")} /> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** One billing entry per application that has an operator-configured billing portal. */
export function BillingPage({ applications }: { applications: AccountApplication[] }) {
  const { t } = useAuthRuntime();
  const { el } = useElementClasses();
  const billed = applications.filter((app) => app.billingUrl);
  return (
    <section className="flex flex-col gap-3" data-orbit-section="billing">
      <SectionHeader title={t("userProfile.billing.title")} description={t("userProfile.billing.description")} />
      {billed.length === 0 ? (
        <EmptyState text={t("userProfile.billing.empty")} />
      ) : (
        <ul className={cn("flex flex-col divide-y rounded-md border", el("billingList"))}>
          {billed.map((app) => (
            <li key={app.id} className="flex items-center gap-3 px-3 py-2.5">
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{app.name}</span>
              <BillingLink url={app.billingUrl as string} label={t("userProfile.billing.manage")} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
