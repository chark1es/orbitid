import { useComponentElements } from "./appearance";
import { useAuthRuntime } from "./w6";

/**
 * Methods that start from the identifier field: the sign-in form labels that field "Last used" when one of
 * them completed the previous sign-in in this browser. Social connections and passkeys carry their own badge.
 */
export const IDENTIFIER_STRATEGIES: ReadonlySet<string> = new Set([
  "password",
  "email_code",
  "email_link",
  "phone_code",
  "enterprise_sso",
  "saml",
]);

/** The "Last used" chip shown next to the sign-in method this browser completed most recently. */
export function LastUsedBadge({ className, testId }: { className?: string; testId?: string }) {
  const { t } = useAuthRuntime();
  const { ep } = useComponentElements();
  return (
    <span
      data-testid={testId}
      {...ep(
        "lastUsedBadge",
        "shrink-0 rounded-sm border border-border bg-card px-1.5 py-0.5 text-2xs leading-none font-medium text-muted-foreground control-optical",
        className,
      )}
    >
      {t("signIn.lastUsed")}
    </span>
  );
}
