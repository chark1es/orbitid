import { Check, Copy } from "lucide-react";
import { Button, cn } from "@orbitid/ui";
import { toast } from "sonner";
import { useCopyToClipboard, useFlash } from "../../lib/hooks";

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
  size?: "icon" | "icon-sm" | "icon-xs" | "sm" | "xs" | "default";
  variant?: "ghost" | "outline" | "secondary" | "default";
  className?: string;
  disabled?: boolean;
}) {
  const copy = useCopyToClipboard();
  const [copied, flashCopied] = useFlash(1500);

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
        flashCopied();
        toast.success("Copied to clipboard");
      }}
    >
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      {size.startsWith("icon") ? null : <span>{copied ? "Copied" : label ?? "Copy"}</span>}
    </Button>
  );
}
