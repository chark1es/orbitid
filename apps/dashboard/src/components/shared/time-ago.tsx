import { cn } from "@orbitid/ui";
import { formatDateTime, formatRelativeTime } from "../../lib/format";

export function TimeAgo({
  value,
  className,
  fallback = "—",
}: {
  value: number | null | undefined;
  className?: string;
  fallback?: string;
}) {
  if (!value) return <span className={cn("text-muted-foreground", className)}>{fallback}</span>;
  return (
    <time
      dateTime={new Date(value).toISOString()}
      title={formatDateTime(value)}
      className={cn("whitespace-nowrap tabular-nums", className)}
    >
      {formatRelativeTime(value)}
    </time>
  );
}
