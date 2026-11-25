import { AlertCircleIcon, LockIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@orbitid/ui";
import { useComponentElements } from "./appearance";
import { useAuthRuntime } from "./w6";

export interface FormErrorProps {
  message?: string | null;
  title?: string;
  className?: string;
  onRetry?: () => void;
}

/** Destructive alert used for API/form errors. Always announced to assistive tech. */
export function FormError({ message, title, className, onRetry }: FormErrorProps) {
  const { ep } = useComponentElements();
  const { t } = useAuthRuntime();
  if (!message) return null;
  return (
    <Alert
      variant="destructive"
      role="alert"
      aria-live="assertive"
      {...ep("alert", "items-start", className)}
    >
      <AlertCircleIcon aria-hidden="true" />
      {title ? <AlertTitle>{title}</AlertTitle> : null}
      <AlertDescription>
        <p>{message}</p>
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="mt-1 text-sm font-medium underline underline-offset-4"
          >
            {t("common.tryAgain")}
          </button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

/** "Secured by OrbitID". Follows the instance's branding setting unless `layout.showBranding` says otherwise. */
export function SecuredByOrbitID({ className }: { className?: string }) {
  const { environment, t } = useAuthRuntime();
  const { ep, appearance } = useComponentElements();
  const show = appearance.layout.showBranding ?? environment.app.branded;
  if (!show) return null;
  return (
    <p
      {...ep("securedBy", "flex items-center justify-center gap-1.5 text-xs text-muted-foreground", className)}
    >
      <LockIcon className="size-3" aria-hidden="true" />
      {t("footer.securedBy")}
    </p>
  );
}

/** Terms, privacy and help links: `appearance.layout` URLs first, then the instance's own. */
export function FooterPages() {
  const { environment, t } = useAuthRuntime();
  const { ep, appearance } = useComponentElements();
  const layout = appearance.layout;
  if (layout.showFooterPages === false) return null;
  const pages = [
    { href: layout.helpPageUrl, label: t("footer.help") },
    { href: layout.privacyPageUrl || environment.app.privacyUrl, label: t("footer.privacy") },
    { href: layout.termsPageUrl || environment.app.termsUrl, label: t("footer.terms") },
  ].filter((page): page is { href: string; label: string } => Boolean(page.href));
  if (pages.length === 0) return null;
  return (
    <nav {...ep("footerPages", "flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground")} aria-label={environment.app.name}>
      {pages.map((page) => (
        <a
          key={page.label}
          href={page.href}
          rel="noreferrer"
          {...ep("footerPagesLink", "rounded-sm underline-offset-4 transition-colors hover:text-foreground hover:underline")}
        >
          {page.label}
        </a>
      ))}
    </nav>
  );
}
