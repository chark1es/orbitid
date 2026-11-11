import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@orbitid/ui";

/**
 * Empty states say what will appear here and name the next action.
 *
 * `variant="compact"` is for an empty list inside a table or card, where 213px of padding pushes the
 * surrounding controls off a 375px screen. Whole-page empty states keep the full measure.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  variant = "full",
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  variant?: "compact" | "full";
  className?: string;
}) {
  return (
    <div
      data-variant={variant}
      className={cn(
        "flex flex-col items-center gap-2 px-6 text-center",
        variant === "compact" ? "py-8" : "py-14",
        className,
      )}
    >
      {Icon ? <Icon className="size-4 text-muted-foreground" aria-hidden /> : null}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description ? <p className="max-w-[52ch] text-sm leading-6 text-muted-foreground">{description}</p> : null}
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}
