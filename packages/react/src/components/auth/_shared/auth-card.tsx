import type { ReactNode } from "react";
import { AlertTriangleIcon } from "lucide-react";
import {
  Alert,
  AlertDescription,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  OrbitMark,
} from "@orbitid/ui";
import { useAuthAppearance, useElementClasses } from "./appearance";
import { ComponentRoot } from "./component-root";
import { useAuthRuntime } from "./w6";
import { FooterPages, SecuredByOrbitID } from "./form-error";

export interface AuthCardProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  headerAction?: ReactNode;
  className?: string;
  contentClassName?: string;
  showLogo?: boolean;
  /** Rendered above the title, e.g. an icon for a verification step. */
  eyebrow?: ReactNode;
}

/**
 * The card every auth flow renders in: logo, title and subtitle on top, the step in the middle, and a quiet footer
 * band with the instance's pages and the "Secured by" line. Branding, theme and `appearance` come from
 * `ComponentRoot`.
 */
export function AuthCard({
  title,
  subtitle,
  children,
  footer,
  headerAction,
  className,
  contentClassName,
  showLogo = true,
  eyebrow,
}: AuthCardProps) {
  const runtime = useAuthRuntime();
  const { environment, t, navigate } = runtime;
  const appearance = useAuthAppearance();
  const { ep } = useElementClasses();

  const layout = appearance.layout ?? {};
  const logoPlacement = layout.logoPlacement ?? "inside";
  const logoSrc = layout.logoImageUrl || environment.app.logoUrl;
  const logoHref = layout.logoLinkUrl || environment.app.homeUrl;
  const shouldShowLogo = showLogo && logoPlacement !== "none";
  const showDevBanner =
    environment.app.developmentMode &&
    layout.showDevelopmentModeWarning !== false &&
    layout.unsafe_disableDevelopmentModeWarnings !== true;

  const logo = shouldShowLogo ? (
    <div {...ep("logoBox", "flex items-center justify-center")}>
      <a
        href={logoHref}
        className="rounded-md outline-none"
        aria-label={environment.app.name}
        onClick={(event) => {
          if (logoHref.startsWith("/")) {
            event.preventDefault();
            navigate(logoHref);
          }
        }}
      >
        {logoSrc ? (
          <img
            src={logoSrc}
            alt={environment.app.name}
            {...ep("logoImage", "h-9 w-auto max-w-[10rem] object-contain")}
          />
        ) : (
          <OrbitMark color="var(--primary)" {...ep("logoImage", "size-9")} />
        )}
      </a>
    </div>
  ) : null;

  return (
    <ComponentRoot component="auth-card" className="flex w-full flex-col items-center">
      {logoPlacement === "outside" ? <div className="mb-6">{logo}</div> : null}
      <Card {...ep("cardBox", "w-full max-w-[25rem] gap-0 overflow-hidden rounded-xl py-0 shadow-card", className)}>
        <CardHeader {...ep("header", "items-center gap-0 px-8 pt-8 pb-6 text-center max-[400px]:px-6")}>
          {logoPlacement === "inside" && logo ? <div className="mb-5">{logo}</div> : null}
          {eyebrow ? <div className="mb-4 flex items-center justify-center">{eyebrow}</div> : null}
          <div className="flex w-full items-start justify-between gap-2">
            <div className="flex-1">
              <CardTitle
                role="heading"
                aria-level={2}
                {...ep("headerTitle", "text-lg leading-snug font-heading tracking-[-0.01em] text-balance")}
              >
                {title}
              </CardTitle>
              {subtitle ? (
                <CardDescription {...ep("headerSubtitle", "mt-1 text-sm text-balance")}>{subtitle}</CardDescription>
              ) : null}
            </div>
            {headerAction}
          </div>
        </CardHeader>
        <CardContent {...ep("main", "flex flex-col gap-5 px-8 pb-8 max-[400px]:px-6", contentClassName)}>
          {showDevBanner ? (
            <Alert {...ep("developmentModeBanner", "w-full items-start border-caution/30 bg-caution/8 py-2.5")}>
              <AlertTriangleIcon aria-hidden="true" className="text-caution" />
              <AlertDescription className="text-xs text-caution">{t("devMode.banner")}</AlertDescription>
            </Alert>
          ) : null}
          {children}
        </CardContent>
        <CardFooter {...ep("footer", "flex flex-col items-center gap-2.5 border-t bg-muted/60 px-8 py-4 empty:hidden")}>
          {footer}
          <SecuredByOrbitID />
          <FooterPages />
        </CardFooter>
      </Card>
    </ComponentRoot>
  );
}
