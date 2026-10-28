import type { ReactNode } from "react";
import { Alert, AlertDescription, Button, Skeleton, cn } from "@orbitid/ui";
import { AlertCircleIcon, RefreshCwIcon } from "lucide-react";
import { useLocalizations } from "../../../localization";

export interface ErrorBannerProps {
  message?: string | null;
  onRetry?: () => void;
  className?: string;
}

/** Inline error surface with an optional retry action. */
export function ErrorBanner({ message, onRetry, className }: ErrorBannerProps) {
  const { t } = useLocalizations();
  if (!message) return null;
  return (
    <Alert variant="destructive" className={cn("items-center", className)}>
      <AlertCircleIcon aria-hidden="true" />
      <AlertDescription>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>{message}</span>
          {onRetry ? (
            <Button type="button" variant="outline" size="xs" onClick={onRetry}>
              <RefreshCwIcon aria-hidden="true" />
              {t("status.retry")}
            </Button>
          ) : null}
        </div>
      </AlertDescription>
    </Alert>
  );
}

/** Field-level error text (`role="alert"`). */
export function FieldError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <p className="text-sm text-destructive" role="alert">
      {message}
    </p>
  );
}

/** Muted empty-state text. */
export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{children}</p>;
}

/** Skeleton rows shown while a table loads for the first time. */
export function LoadingRows({ rows = 3 }: { rows?: number }) {
  const { t } = useLocalizations();
  return (
    <div className="flex flex-col gap-2 py-3" aria-busy="true" aria-label={t("status.loading")}>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-10 w-full" />
      ))}
    </div>
  );
}

export interface PaginationBarProps {
  /** 1-based current page (matches `PagedResource.page`). */
  page: number;
  pageCount: number;
  totalCount: number;
  pageSize: number;
  isLoading?: boolean;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  onNext: () => void | Promise<void>;
  onPrevious: () => void | Promise<void>;
  className?: string;
}

/** Offset pagination footer shared by the org tables. */
export function PaginationBar({
  page,
  pageCount,
  totalCount,
  pageSize,
  isLoading,
  hasNextPage,
  hasPreviousPage,
  onNext,
  onPrevious,
  className,
}: PaginationBarProps) {
  const { t } = useLocalizations();
  if (totalCount === 0) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(totalCount, page * pageSize);
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-2 pt-3 text-sm text-muted-foreground",
        className,
      )}
    >
      <span data-testid="pagination-summary">
        {t("paginationRowText__displaying")} {from}–{to} {t("paginationRowText__of")} {totalCount}
      </span>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={t("paginationButton__previous")}
          disabled={!hasPreviousPage || isLoading}
          onClick={() => void onPrevious()}
        >
          {t("paginationButton__previous")}
        </Button>
        <span aria-live="polite">
          {page} / {pageCount}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={t("paginationButton__next")}
          disabled={!hasNextPage || isLoading}
          onClick={() => void onNext()}
        >
          {t("paginationButton__next")}
        </Button>
      </div>
    </div>
  );
}
