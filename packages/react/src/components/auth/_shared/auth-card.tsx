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
  cn,
} from "@orbitid/ui";
import { useAuthAppearance, useElementClasses, useResolvedTheme } from "./appearance";
import { contrastForeground } from "../../../appearance";
import { useAuthRuntime } from "./w6";
import { SecuredByOrbitID } from "./form-error";

const OrbitMark = ({ color }: { color: string }) => (
  <svg viewBox="0 0 32 32" role="img" aria-hidden="true" className="size-10">
    <circle cx="16" cy="16" r="13" fill="none" stroke={color} strokeWidth="2.5" opacity="0.35" />
    <ellipse cx="16" cy="16" rx="13" ry="5.5" fill="none" stroke={color} strokeWidth="2.5" transform="rotate(-30 16 16)" />
    <circle cx="16" cy="16" r="4" fill={color} />
  </svg>
);

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

/** Shared shadcn card shell: branding, theme, development banner, pages, "Secured by OrbitID". */
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
  const { el, primaryColor, cssVariables, rootClassName } = useElementClasses();
  const resolvedTheme = useResolvedTheme();
  const brandingStyle: Record<string, string> = { ...cssVariables };
  if (!appearance.variables.colorPrimary) {
    brandingStyle["--primary"] = primaryColor;
    brandingStyle["--ring"] = primaryColor;
    const foreground = contrastForeground(primaryColor);
    if (foreground) brandingStyle["--primary-foreground"] = foreground;
  }

  const layout = appearance.layout ?? {};
  const logoPlacement = layout.logoPlacement ?? "inside";
  const logoSrc = layout.logoImageUrl || environment.app.logoUrl;
  const logoHref = layout.logoLinkUrl || environment.app.homeUrl;
  const termsUrl = layout.termsPageUrl || environment.app.termsUrl;
  const privacyUrl = layout.privacyPageUrl || environment.app.privacyUrl;
  const shouldShowLogo = showLogo && logoPlacement !== "none";

  const logo = shouldShowLogo ? (
    <div className={cn("flex items-center justify-center", el("logoBox"))}>
      <a
        href={logoHref}
        className="rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
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
            className={cn("h-10 w-auto max-w-[10rem] object-contain", el("logoImage"))}
          />
        ) : (
          <OrbitMark color={primaryColor} />
        )}
      </a>
    </div>
  ) : null;

  return (
    <div
      data-orbit-component="auth-card"
      data-orbit-theme={resolvedTheme}
      className={cn(resolvedTheme === "dark" && "dark", "flex w-full flex-col items-center", rootClassName, el("rootBox"))}
      style={brandingStyle}
    >
      {logoPlacement === "outside" ? <div className="mb-4">{logo}</div> : null}
      <Card
        className={cn(
          "w-full max-w-[25rem] gap-0 overflow-hidden border-border/70 shadow-sm",
          el("card"),
          el("cardBox"),
          className,
        )}
      >
        <CardHeader className={cn("items-center gap-2 text-center", el("header"))}>
          {logoPlacement === "inside" ? logo : null}
          {eyebrow ? <div className="flex items-center justify-center">{eyebrow}</div> : null}
          <div className="flex w-full items-start justify-between gap-2">
            <div className="flex-1">
              <CardTitle role="heading" aria-level={2} className={cn("text-xl font-semibold tracking-tight", el("headerTitle"))}>{title}</CardTitle>
              {subtitle ? (
                <CardDescription className={cn("mt-1 text-sm text-balance", el("headerSubtitle"))}>
                  {subtitle}
                </CardDescription>
              ) : null}
            </div>
            {headerAction}
          </div>
        </CardHeader>
        <CardContent className={cn("flex flex-col gap-5", el("form"), contentClassName)}>
          {environment.app.developmentMode ? (
            <Alert className={cn("w-full items-start border-amber-500/30 bg-amber-500/10", el("alert"))}>
              <AlertTriangleIcon aria-hidden="true" className="text-amber-600 dark:text-amber-400" />
              <AlertDescription className="text-xs text-amber-900 dark:text-amber-200">
                {t("devMode.banner")}
              </AlertDescription>
            </Alert>
          ) : null}
          {children}
        </CardContent>
        <CardFooter
          className={cn("flex flex-col items-center gap-3 border-t border-border/60 bg-muted/20 py-4", el("footer"))}
        >
          {footer}
          {termsUrl || privacyUrl ? (
            <nav
              className={cn("flex items-center gap-3 text-xs text-muted-foreground", el("footerPages"))}
              aria-label={environment.app.name}
            >
              {termsUrl ? (
                <a href={termsUrl} className="hover:text-foreground hover:underline" rel="noreferrer">
                  {t("footer.terms")}
                </a>
              ) : null}
              {privacyUrl ? (
                <a href={privacyUrl} className="hover:text-foreground hover:underline" rel="noreferrer">
                  {t("footer.privacy")}
                </a>
              ) : null}
            </nav>
          ) : null}
          <SecuredByOrbitID />
        </CardFooter>
      </Card>
    </div>
  );
}
