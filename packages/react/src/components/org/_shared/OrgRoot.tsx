import type { ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle, cn } from "@orbitid/ui";
import { BuildingIcon } from "lucide-react";
import type { Appearance, ComponentElementKey } from "../../../appearance";
import { useLocalizations } from "../../../localization";
import { AuthAppearanceScope } from "../../auth/_shared/appearance";
import { ComponentRoot } from "../../auth/_shared/component-root";
import { useOrgSettings } from "./hooks";

function OrgBox({ className, element, children }: { className?: string; element?: ComponentElementKey; children: ReactNode }) {
  // The scheme class, branding, variables and `rootBox` all come from the shared component root.
  return (
    <ComponentRoot component="organization" element={element} className={cn("orbitid-org w-full text-foreground", className)}>
      {children}
    </ComponentRoot>
  );
}

export interface OrgRootProps {
  /** Component-level appearance merged over the provider's appearance. */
  appearance?: Appearance;
  className?: string;
  /**
   * What to render while the instance has organizations turned off: a locked notice (default), or nothing
   * for compact controls such as the switcher that would otherwise leave a stray message in a navbar.
   */
  whenDisabled?: "notice" | "hidden";
  /** Component element key for the root (`organizationProfile`, `apiKeys`, …). */
  element?: ComponentElementKey;
  /** Set `false` for surfaces that also work without organizations, such as a user's own API keys. */
  requiresOrganizations?: boolean;
  children: ReactNode;
}

function OrganizationsDisabledNotice() {
  const { t } = useLocalizations();
  return (
    <Alert>
      <BuildingIcon aria-hidden />
      <AlertTitle>{t("organizationsDisabled.title")}</AlertTitle>
      <AlertDescription>{t("organizationsDisabled.message")}</AlertDescription>
    </Alert>
  );
}

/**
 * Locks the subtree while organizations are off. Children are not mounted, so none of their hooks
 * fetch memberships, invitations or domains the server would only refuse.
 */
function OrgGate({ whenDisabled, children }: { whenDisabled: "notice" | "hidden"; children: ReactNode }) {
  const settings = useOrgSettings();
  if (settings.enabled) return <>{children}</>;
  return whenDisabled === "hidden" ? null : <OrganizationsDisabledNotice />;
}

/** Root wrapper for every org component: merges the `appearance` prop, applies `rootBox`, and locks it when organizations are off. */
export function OrgRoot({
  appearance,
  className,
  element,
  whenDisabled = "notice",
  requiresOrganizations = true,
  children,
}: OrgRootProps) {
  const gated = requiresOrganizations ? <OrgGate whenDisabled={whenDisabled}>{children}</OrgGate> : children;
  return (
    <AuthAppearanceScope appearance={appearance}>
      <OrgBox className={className} element={element}>
        {gated}
      </OrgBox>
    </AuthAppearanceScope>
  );
}
