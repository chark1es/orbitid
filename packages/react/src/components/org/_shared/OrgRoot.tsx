import { useMemo, type ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle, cn } from "@orbitid/ui";
import { BuildingIcon } from "lucide-react";
import { AppearanceContext } from "../../../provider";
import { resolveAppearance, useAppearance, type Appearance } from "../../../appearance";
import { useLocalizations } from "../../../localization";
import { useThemeScope } from "../../auth/_shared/appearance";
import { useOrgSettings } from "./hooks";

function OrgBox({ className, children }: { className?: string; children: ReactNode }) {
  const appearance = useAppearance();
  // The scheme class is not part of `rootClassName`; a forced `dark` base theme still renders dark through here.
  const { className: themeClass } = useThemeScope();
  return (
    <div
      className={cn(themeClass, "orbitid-org w-full text-foreground", appearance.rootClassName, className)}
      style={appearance.cssVariables}
    >
      {children}
    </div>
  );
}

function AppearanceScope({
  appearance,
  children,
}: {
  appearance: Appearance;
  children: ReactNode;
}) {
  const parent = useAppearance();
  const resolved = useMemo(() => {
    const base = parent.appearance;
    return resolveAppearance({
      ...base,
      ...appearance,
      elements: { ...base?.elements, ...appearance.elements },
      variables: { ...base?.variables, ...appearance.variables },
      layout: { ...base?.layout, ...appearance.layout },
    });
  }, [parent.appearance, appearance]);
  return <AppearanceContext.Provider value={resolved}>{children}</AppearanceContext.Provider>;
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
  whenDisabled = "notice",
  requiresOrganizations = true,
  children,
}: OrgRootProps) {
  const gated = requiresOrganizations ? <OrgGate whenDisabled={whenDisabled}>{children}</OrgGate> : children;
  if (!appearance) return <OrgBox className={className}>{gated}</OrgBox>;
  return (
    <AppearanceScope appearance={appearance}>
      <OrgBox className={className}>{gated}</OrgBox>
    </AppearanceScope>
  );
}
