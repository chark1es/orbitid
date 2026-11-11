import type { ReactNode } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@orbitid/ui";
import { OVERLAY_WIDTH } from "./overlay-sizes";
import { TriangleAlert } from "lucide-react";
import { CopyButton } from "./copy-button";

/** One-time secret display (API key, invite URL). */
export function SecretReveal({
  open,
  onOpenChange,
  title,
  description,
  secret,
  warning,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  secret: string;
  warning?: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={`rounded-[6px] ${OVERLAY_WIDTH.form}`}>
        <DialogHeader>
          <DialogTitle className="text-base font-heading tracking-[-0.01em]">{title}</DialogTitle>
          {description ? (
            <DialogDescription className="text-sm leading-6 text-muted-foreground">{description}</DialogDescription>
          ) : null}
        </DialogHeader>
        <div className="flex items-start gap-2 rounded-[4px] border border-border bg-muted/40 p-2.5">
          <code className="min-w-0 flex-1 break-all font-mono text-xs leading-5">{secret}</code>
          <CopyButton value={secret} label="Copy" size="sm" variant="outline" />
        </div>
        {warning ? (
          <p className="flex items-start gap-2 text-sm leading-6 text-foreground">
            <TriangleAlert className="mt-1 size-4 shrink-0 text-caution" strokeWidth={1.5} aria-hidden />
            <span>{warning}</span>
          </p>
        ) : null}
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
