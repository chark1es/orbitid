import type { ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
} from "@orbitid/ui";
import { Loader2 } from "lucide-react";
import { OVERLAY_WIDTH } from "./overlay-sizes";

/** Destructive confirmation: name the object, say what happens, one destructive button. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  pending = false,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  pending?: boolean;
  onConfirm: () => void;
  /** Extra fields shown above the footer, such as the optional reason for a revocation. */
  children?: ReactNode;
}) {
  // Escape and an overlay press are dismissals too. While the destructive request is in flight there
  // is nothing safe to return to, so the dialog ignores them until the request settles.
  function handleOpenChange(next: boolean) {
    if (!next && pending) return;
    onOpenChange(next);
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent className={`rounded-[6px] border-border ${OVERLAY_WIDTH.form}`}>
        <AlertDialogHeader>
          <AlertDialogTitle className="text-base font-heading tracking-[-0.01em]">{title}</AlertDialogTitle>
          {description ? (
            <AlertDialogDescription className="text-sm leading-6 text-muted-foreground">
              {description}
            </AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        {children ? <div className="space-y-3">{children}</div> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{cancelLabel}</AlertDialogCancel>
          <Button variant={destructive ? "destructive" : "default"} disabled={pending} onClick={onConfirm}>
            {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
