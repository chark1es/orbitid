import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, cn } from "@orbitid/ui";
import type { LucideIcon } from "lucide-react";

export function StatCard({
  title,
  value,
  hint,
  icon: Icon,
  loading,
  className,
}: {
  title: string;
  value: ReactNode;
  hint?: ReactNode;
  icon: LucideIcon;
  loading?: boolean;
  className?: string;
}) {
  return (
    <Card className={cn("gap-2", className)}>
      <CardHeader className="pb-0">
        <CardDescription className="flex items-center justify-between gap-2 text-xs font-medium uppercase tracking-wide">
          <span>{title}</span>
          <Icon className="size-4 text-muted-foreground" aria-hidden />
        </CardDescription>
        <CardTitle className="text-2xl tabular-nums">
          {loading ? <span className="inline-block h-7 w-16 animate-pulse rounded bg-muted" /> : value}
        </CardTitle>
      </CardHeader>
      {hint ? (
        <CardContent className="pt-0">
          <p className="text-xs text-muted-foreground">{hint}</p>
        </CardContent>
      ) : null}
    </Card>
  );
}
