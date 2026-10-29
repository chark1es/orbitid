import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@orbitid/ui";

/** Empty states say what will appear here and name the next action. */
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
    <div className={cn("flex flex-col items-center gap-2 px-6 py-14 text-center", className)}>
      {Icon ? <Icon className="size-5 text-muted-foreground" strokeWidth={1.5} aria-hidden /> : null}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description ? <p className="max-w-[52ch] text-sm leading-6 text-muted-foreground">{description}</p> : null}
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}
