import { useMemo, type ReactNode } from "react";
import { cn } from "@orbitid/ui";
import { AppearanceContext } from "../../../provider";
import { resolveAppearance, useAppearance, type Appearance } from "../../../appearance";

function OrgBox({ className, children }: { className?: string; children: ReactNode }) {
  const appearance = useAppearance();
  return (
    <div
      className={cn("orbitid-org w-full text-foreground", appearance.rootClassName, className)}
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
  children: ReactNode;
}

/** Root wrapper for every org component: merges the `appearance` prop and applies `rootBox`. */
export function OrgRoot({ appearance, className, children }: OrgRootProps) {
  if (!appearance) return <OrgBox className={className}>{children}</OrgBox>;
  return (
    <AppearanceScope appearance={appearance}>
      <OrgBox className={className}>{children}</OrgBox>
    </AppearanceScope>
  );
}
