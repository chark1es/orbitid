import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button, cn } from "@orbitid/ui";
import { toast } from "sonner";
import { useCopyToClipboard } from "../../lib/hooks";

export function CopyButton({
  value,
  label,
  size = "icon",
  variant = "ghost",
  className,
  disabled,
}: {
  value: string;
  label?: string;
  size?: "icon" | "sm" | "xs" | "default";
  variant?: "ghost" | "outline" | "secondary" | "default";
  className?: string;
  disabled?: boolean;
}) {
  const copy = useCopyToClipboard();
  const [copied, setCopied] = useState(false);

  return (
    <Button
      type="button"
      size={size}
      variant={variant}
      className={cn(className)}
      disabled={disabled || !value}
      aria-label={label ?? "Copy to clipboard"}
      onClick={async (event) => {
        event.stopPropagation();
        const ok = await copy(value);
        if (!ok) {
          toast.error("Could not copy to clipboard");
          return;
        }
        setCopied(true);
        toast.success("Copied to clipboard");
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      {size !== "icon" ? <span>{copied ? "Copied" : label ?? "Copy"}</span> : null}
    </Button>
  );
}
