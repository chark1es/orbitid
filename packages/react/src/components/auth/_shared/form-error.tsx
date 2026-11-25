import { AlertCircleIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@orbitid/ui";
import { cn } from "@orbitid/ui";
import { useElementClasses } from "./appearance";
import { useAuthRuntime } from "./w6";

export interface FormErrorProps {
  message?: string | null;
  title?: string;
  className?: string;
  onRetry?: () => void;
}

/** Destructive alert used for API/form errors. Always announced to assistive tech. */
export function FormError({ message, title, className, onRetry }: FormErrorProps) {
  const { el } = useElementClasses();
  const { t } = useAuthRuntime();
  if (!message) return null;
  return (
    <Alert
      variant="destructive"
      role="alert"
      aria-live="assertive"
      data-orbit-element="alert"
      className={cn("items-start", el("alert"), className)}
    >
      <AlertCircleIcon aria-hidden="true" />
      {title ? <AlertTitle className={cn(el("alertText"))}>{title}</AlertTitle> : null}
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
