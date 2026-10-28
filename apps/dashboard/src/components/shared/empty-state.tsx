import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@orbitid/ui";

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 px-6 py-12 text-center", className)}>
      {Icon ? (
        <span className="flex size-11 items-center justify-center rounded-full border bg-muted/40 text-muted-foreground">
          <Icon className="size-5" aria-hidden />
        </span>
      ) : null}
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        {description ? <p className="max-w-sm text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}
