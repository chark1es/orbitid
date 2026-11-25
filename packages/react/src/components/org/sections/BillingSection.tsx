import { useEffect, useState } from "react";
import { Alert, AlertDescription, Button } from "@orbitid/ui";
import { ExternalLinkIcon } from "lucide-react";
import { useOrbitID } from "../../../hooks";
import { useLocalizations } from "../../../localization";
import { safeHttpsUrl } from "../../../lib/profile-pages";
import type { OrganizationBillingResource, OrganizationResource } from "../../../provider";
import { fapiRequest } from "../_shared/fapi";

export interface OrganizationBillingState {
  /** The operator-configured billing portal, already checked to be an https URL. */
  portalUrl: string | null;
  loaded: boolean;
  failed: boolean;
}

const IDLE: OrganizationBillingState = { portalUrl: null, loaded: false, failed: false };

/**
 * Reads the organization's billing portal (`GET /v1/client/organizations/{id}/billing`) when the member may see
 * it. The server enforces `org:sys_billing:manage`; `enabled` only avoids a request that would always be refused.
 */
export function useOrganizationBilling(
  organization: OrganizationResource | null,
  enabled: boolean,
): OrganizationBillingState {
  const instance = useOrbitID();
  // The result is tagged with the organization it belongs to and only returned for that organization, so after a
  // switch the previous organization's portal never renders, not even for the frame before the effect runs.
  const [state, setState] = useState<{ organizationId: string | null; billing: OrganizationBillingState }>({
    organizationId: null,
    billing: IDLE,
  });
  const organizationId = organization?.id ?? null;
  useEffect(() => {
    if (!organization || !enabled) return;
    let cancelled = false;
    const read: Promise<OrganizationBillingResource> =
      typeof organization.getBilling === "function"
        ? organization.getBilling()
        : fapiRequest<OrganizationBillingResource>(
            instance,
            `/organizations/${encodeURIComponent(organization.id)}/billing`,
          ).then((result) => result.data);
    read
      .then((billing) => {
        if (cancelled) return;
        setState({
          organizationId: organization.id,
          billing: { portalUrl: safeHttpsUrl(billing?.portalUrl ?? billing?.portal_url), loaded: true, failed: false },
        });
      })
      .catch(() => {
        if (!cancelled) setState({ organizationId: organization.id, billing: { portalUrl: null, loaded: true, failed: true } });
      });
    return () => {
      cancelled = true;
    };
    // The organization object changes identity on every SDK emit; its id is what matters.
  }, [organizationId, enabled, instance]);
  return enabled && organizationId !== null && state.organizationId === organizationId ? state.billing : IDLE;
}

/** The built-in organization Billing page: a link out to the operator-configured billing portal. */
export function BillingSection({ billing }: { billing: OrganizationBillingState }) {
  const { t } = useLocalizations();
  return (
    <section className="flex flex-col gap-3" aria-label={t("organizationProfile.billing.title")} data-orbit-section="organization-billing">
      <div className="flex flex-col gap-1">
        <h3 className="font-medium">{t("organizationProfile.billing.title")}</h3>
        <p className="text-sm text-muted-foreground">{t("organizationProfile.billing.description")}</p>
      </div>
      {!billing.loaded ? (
        <p className="text-sm text-muted-foreground">{t("status.loading")}</p>
      ) : billing.failed ? (
        <Alert variant="destructive">
          <AlertDescription>{t("organizationProfile.billing.loadFailed")}</AlertDescription>
        </Alert>
      ) : billing.portalUrl ? (
        <Button asChild className="w-fit gap-1.5">
          <a href={billing.portalUrl} target="_blank" rel="noopener noreferrer">
            {t("organizationProfile.billing.manage")}
            <ExternalLinkIcon className="size-4" aria-hidden="true" />
          </a>
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">{t("organizationProfile.billing.notConfigured")}</p>
      )}
    </section>
  );
}
