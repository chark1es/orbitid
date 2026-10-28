import { cn } from "@orbitid/ui";

/**
 * Status is a word plus a 6px dot. The word carries the meaning, the dot carries the tone, so the
 * chip stays readable without colour and the palette stays restrained.
 */
const TONES = {
  positive: { chip: "border-go/35 bg-go/10", dot: "bg-go" },
  warning: { chip: "border-caution/45 bg-caution/12", dot: "bg-caution" },
  negative: { chip: "border-signal/40 bg-signal/10", dot: "bg-signal" },
  info: { chip: "border-info/35 bg-info/10", dot: "bg-info" },
  neutral: { chip: "border-border bg-muted/40", dot: "bg-muted-foreground" },
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
  const palette = TONES[resolvedTone];
  const text = label ?? LABELS[status] ?? status.replace(/_/g, " ");
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-[3px] border px-1.5 py-px text-xs font-medium text-foreground",
        palette.chip,
        className,
      )}
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", palette.dot)} aria-hidden />
      {text.charAt(0).toUpperCase() + text.slice(1)}
    </span>
  );
}
