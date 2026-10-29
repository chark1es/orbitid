export type StatusKind = "enabled" | "off" | "needs-config" | "success" | "failed" | "pending";

const LABELS: Record<StatusKind, string> = {
  enabled: "Enabled",
  off: "Off",
  "needs-config": "Needs config",
  success: "Success",
  failed: "Failed",
  pending: "Pending",
};

const TONES: Record<StatusKind, string> = {
  enabled: "text-go",
  off: "text-muted-foreground",
  "needs-config": "text-caution",
  success: "text-go",
  failed: "text-signal",
  pending: "text-caution",
};

/** A word plus a dot. The word carries the meaning; the dot only reinforces it. */
export function StatusChip({
  kind,
  label,
  className,
}: {
  kind: StatusKind;
  label?: string;
  className?: string;
}) {
  return (
    <span className={["inline-flex items-center gap-1.5 text-xs font-medium", TONES[kind], className].filter(Boolean).join(" ")}>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {label ?? LABELS[kind]}
    </span>
  );
}
