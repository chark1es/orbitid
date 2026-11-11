import type { ReactNode } from "react";
import { cn } from "@orbitid/ui";

/** Title row: page title, one line of description, one primary action. */
export function PageHeader({
  title,
  description,
  descriptionClassName,
  actions,
  badge,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Prose measure override for the one-line description. */
  descriptionClassName?: string;
  actions?: ReactNode;
  badge?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 border-b border-border pb-3 sm:flex-row sm:items-end sm:justify-between",
        className,
      )}
    >
      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-[1.375rem] font-heading leading-tight tracking-[-0.015em] text-foreground">{title}</h1>
          {badge}
        </div>
        {description ? (
          <p className={cn("max-w-[70ch] text-sm leading-6 text-muted-foreground", descriptionClassName)}>{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2 sm:shrink-0">{actions}</div> : null}
    </div>
  );
}
