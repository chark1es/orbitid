import * as React from "react";
import { Button, cn } from "@orbitid/ui";
import { Copy, Eye, EyeOff } from "lucide-react";
import { copyToClipboard } from "./feedback";

export function CopyButton({
  value,
  label,
  size = "icon-sm",
  variant = "ghost",
  className,
}: {
  value: string;
  label?: string;
  size?: "icon" | "icon-sm" | "sm" | "default";
  variant?: "ghost" | "outline" | "secondary" | "default";
  className?: string;
}) {
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={className}
      onClick={() => void copyToClipboard(value)}
      title={label ?? "Copy"}
    >
      <Copy className="size-3.5" aria-hidden />
      {label ? <span>{label}</span> : <span className="sr-only">Copy</span>}
    </Button>
  );
}

export function SecretReveal({
  value,
  emptyLabel = "Not configured",
  warning,
}: {
  value: string | null | undefined;
  emptyLabel?: string;
  warning?: string;
}) {
  const [revealed, setRevealed] = React.useState(false);
  if (!value) return <p className="text-[0.8125rem] text-muted-foreground">{emptyLabel}</p>;
  const displayed = revealed ? value : "••••••••••••";
  return (
    <div className="space-y-1.5">
      <div className="flex min-w-0 items-center gap-1 border border-border bg-muted/40 py-1 pl-2 pr-1">
        <code className={cn("min-w-0 flex-1 truncate font-data text-xs", !revealed && "select-none")} title={revealed ? undefined : "Hidden"}>
          {displayed}
        </code>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => setRevealed((current) => !current)}
          title={revealed ? "Hide" : "Reveal"}
        >
          {revealed ? <EyeOff className="size-3.5" aria-hidden /> : <Eye className="size-3.5" aria-hidden />}
          <span className="sr-only">{revealed ? "Hide secret" : "Reveal secret"}</span>
        </Button>
        <CopyButton value={value} size="icon-sm" />
      </div>
      {warning ? <p className="text-xs leading-relaxed text-muted-foreground">{warning}</p> : null}
    </div>
  );
}
