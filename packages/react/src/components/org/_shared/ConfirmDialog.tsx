import { useEffect, useId, useState, type ReactNode } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  cn,
} from "@orbitid/ui";
import { useLocalizations } from "../../../localization";

export interface ConfirmDialogProps {
  /** Controlled open state; omit to let the dialog manage it (with `trigger`). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Optional trigger rendered by the dialog. */
  trigger?: ReactNode;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** When set, the user must type this exact phrase to enable confirmation. */
  confirmationPhrase?: string;
  /** Label above the typed-confirmation input. */
  confirmationLabel?: string;
  destructive?: boolean;
  /** Server/field error rendered inside the dialog. */
  error?: string | null;
  /** Disables the confirm button (e.g. nothing selected yet). */
  disabled?: boolean;
  onConfirm: () => void | Promise<void>;
  children?: ReactNode;
  className?: string;
}

/**
 * Confirmation dialog for destructive actions. Supports typed confirmation (`type the
 * organization name`) and shows async errors without closing.
 */
export function ConfirmDialog({
  open: openProp,
  onOpenChange,
  trigger,
  title,
  description,
  confirmLabel,
  cancelLabel,
  confirmationPhrase,
  confirmationLabel,
  destructive,
  error,
  disabled,
  onConfirm,
  children,
  className,
}: ConfirmDialogProps) {
  const { t } = useLocalizations();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = openProp ?? uncontrolledOpen;
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const inputId = useId();

  useEffect(() => {
    if (open) {
      setTyped("");
      setBusy(false);
    }
  }, [open]);

  const setOpen = (next: boolean) => {
    if (openProp === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  const matches =
    !confirmationPhrase || typed.trim().toLowerCase() === confirmationPhrase.trim().toLowerCase();

  const confirm = async () => {
    if (busy || !matches) return;
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {trigger ?? null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className={cn("sm:max-w-md", className)}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </DialogHeader>
          {children}
          {confirmationPhrase ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={inputId}>{confirmationLabel ?? t("formFieldLabel__confirmDeletion")}</Label>
              <Input
                id={inputId}
                value={typed}
                autoComplete="off"
                placeholder={confirmationPhrase}
                onChange={(event) => setTyped(event.target.value)}
                aria-invalid={typed.length > 0 && !matches ? true : undefined}
              />
            </div>
          ) : null}
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {cancelLabel ?? t("formButtonReset")}
            </Button>
            <Button
              type="button"
              variant={destructive ? "destructive" : "default"}
              disabled={disabled || !matches || busy}
              onClick={() => {
                void confirm();
              }}
            >
              {busy ? t("status.loading") : (confirmLabel ?? t("formButtonPrimary"))}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
