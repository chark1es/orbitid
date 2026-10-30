import * as React from "react";
import { Button, Skeleton, cn } from "@orbitid/ui";
import { AlertCircle, Inbox, Info, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

/** Inline note with a worded state. Sits in the page flow, never as a floating toast. */
export function Notice({
  tone = "info",
  title,
  children,
  role = "note",
}: {
  tone?: "info" | "caution" | "danger";
  title: string;
  children?: React.ReactNode;
  role?: "note" | "status" | "alert";
}) {
  const Icon = tone === "danger" ? AlertCircle : tone === "caution" ? TriangleAlert : Info;
  return (
    <div
      role={role}
      className={cn(
        "rounded-md border px-3 py-2.5",
        tone === "danger" ? "border-destructive/40" : tone === "caution" ? "border-caution/50" : "border-border",
      )}
    >
      <p className="flex items-start gap-2 text-sm font-medium">
        <Icon
          className={cn("mt-0.5 size-4 shrink-0", tone === "danger" ? "text-destructive" : tone === "caution" ? "text-caution" : "text-muted-foreground")}
          strokeWidth={1.5}
          aria-hidden
        />
        {title}
      </p>
      {children ? <div className="mt-1 space-y-1 pl-6 text-[0.8125rem] leading-relaxed text-muted-foreground">{children}</div> : null}
    </div>
  );
}


export function LoadingPage({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-8" aria-busy="true" aria-label="Loading settings">
      <div className="space-y-2 pb-1">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="grid gap-x-10 gap-y-4 border-t border-border pt-6 lg:grid-cols-[220px_minmax(0,1fr)]">
          <div className="space-y-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-3 w-40" />
          </div>
          <div className="space-y-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-px border-y border-border py-1" aria-busy="true" aria-label="Loading rows">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="flex h-10 items-center gap-4 px-2">
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-3.5 flex-1" />
          <Skeleton className="h-3.5 w-20" />
        </div>
      ))}
    </div>
  );
}

export function ErrorAlert({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3">
      <div className="flex items-start gap-2.5">
        <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium">Could not load this data</p>
          <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">
            {error} Check that the server is running, then try again.
          </p>
          {onRetry ? (
            <Button variant="outline" size="sm" className="mt-1" onClick={onRetry}>
              Try again
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 border-y border-border px-6 py-14 text-center">
      <div className="text-muted-foreground" aria-hidden>
        {icon ?? <Inbox className="size-5" />}
      </div>
      <p className="text-sm font-medium">{title}</p>
      {description ? <p className="max-w-[60ch] text-[0.8125rem] leading-relaxed text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export async function copyToClipboard(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    toast.success("Copied to clipboard");
  } catch {
    toast.error("Could not copy", { description: "Select the text and copy it manually." });
  }
}
