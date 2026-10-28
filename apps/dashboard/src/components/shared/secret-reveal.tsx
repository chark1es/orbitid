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
import { TriangleAlert } from "lucide-react";
import { CopyButton } from "./copy-button";

/** One-time secret display (API key, impersonation token, invite URL). */
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
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <div className="flex items-start gap-2 rounded-lg border bg-muted/40 p-3">
          <code className="min-w-0 flex-1 break-all font-mono text-xs">{secret}</code>
          <CopyButton value={secret} label="Copy" size="sm" variant="outline" />
        </div>
        {warning ? (
          <p className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-300">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
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
