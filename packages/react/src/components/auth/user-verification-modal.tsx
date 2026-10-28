import { useCallback, useRef, useState } from "react";
import { useRegisterReverificationUI, type ReverificationRequest } from "../../provider";
import { toAuthError } from "./_shared/api";
import { ReverificationDialog } from "./_shared/reverification";
import type { VerificationModalProps } from "./_shared/types";

/**
 * First-factor / second-factor reverification modal.
 *
 * Registers with the provider's reverification registry, so `useReverification()` wraps a sensitive
 * action, opens this dialog, and retries once the user verifies. Also works standalone with
 * `open` / `onVerified`.
 */
export function UserVerificationModal({
  open,
  onOpenChange,
  onVerified,
  onCancel,
  title,
  subtitle,
}: VerificationModalProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [requireSecondFactor, setRequireSecondFactor] = useState(false);
  const pending = useRef<((verified: boolean) => void) | null>(null);

  const handleRequest = useCallback((request?: ReverificationRequest) => {
    const meta = request?.error ? toAuthError(request.error).meta : undefined;
    const level = request?.level ?? meta?.level;
    setRequireSecondFactor(level === "second_factor" || level === "multi_factor");
    setInternalOpen(true);
    return new Promise<boolean>((resolve) => {
      pending.current = resolve;
    });
  }, []);

  useRegisterReverificationUI(handleRequest);

  const settle = (verified: boolean) => {
    setInternalOpen(false);
    pending.current?.(verified);
    pending.current = null;
  };

  const isOpen = open ?? internalOpen;

  return (
    <ReverificationDialog
      open={isOpen}
      title={title}
      subtitle={subtitle}
      requireSecondFactor={requireSecondFactor}
      onOpenChange={(next) => {
        onOpenChange?.(next);
        if (!next) setInternalOpen(false);
      }}
      onVerified={() => {
        onVerified?.();
        settle(true);
      }}
      onCancel={() => {
        onCancel?.();
        settle(false);
      }}
    />
  );
}
