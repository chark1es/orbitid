import { Badge, cn } from "@orbitid/ui";

const TONES = {
  positive: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  warning: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  negative: "border-destructive/40 bg-destructive/10 text-destructive dark:text-red-300",
  neutral: "border-border bg-muted/60 text-muted-foreground",
  info: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
} as const;

const STATUS_TONES: Record<string, keyof typeof TONES> = {
  active: "positive",
  verified: "positive",
  complete: "positive",
  completed: "positive",
  accepted: "positive",
  success: "positive",
  enabled: "positive",
  pending: "warning",
  invited: "info",
  transferable: "info",
  preparing: "info",
  needs_identifier: "warning",
  needs_first_factor: "warning",
  needs_second_factor: "warning",
  needs_new_password: "warning",
  unverified: "neutral",
  ended: "neutral",
  expired: "neutral",
  removed: "neutral",
  abandoned: "neutral",
  replaced: "neutral",
  failed: "negative",
  revoked: "negative",
  rejected: "negative",
  banned: "negative",
  locked: "negative",
  deleted: "negative",
};

const LABELS: Record<string, string> = {
  needs_identifier: "needs identifier",
  needs_first_factor: "needs first factor",
  needs_second_factor: "needs second factor",
  needs_new_password: "needs password",
};

export function StatusBadge({
  status,
  label,
  tone,
  className,
}: {
  status: string;
  label?: string;
  tone?: keyof typeof TONES;
  className?: string;
}) {
  const resolvedTone = tone ?? STATUS_TONES[status] ?? "neutral";
  return (
    <Badge variant="outline" className={cn("gap-1.5 font-normal", TONES[resolvedTone], className)}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {label ?? LABELS[status] ?? status}
    </Badge>
  );
}
