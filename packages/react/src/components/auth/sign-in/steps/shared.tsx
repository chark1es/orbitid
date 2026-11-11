import { useEffect, useRef } from "react";
import { Button, Separator, cn } from "@orbitid/ui";
import { FingerprintIcon } from "lucide-react";
import { factorsOf } from "../../_shared/api";
import { useAuthRuntime, type TranslateFn } from "../../_shared/w6";
import { useElementClasses } from "../../_shared/appearance";
import type { SignInProps, SignInResource } from "../../_shared/types";
import type { SignInFlow } from "../flow";

export interface StepProps {
  flow: SignInFlow;
  props: SignInProps;
}

export function Divider() {
  const { t } = useAuthRuntime();
  const { el } = useElementClasses();
  return (
    <div className="flex items-center gap-3" role="separator">
      <Separator className={cn("flex-1", el("dividerLine"))} />
      <span className={cn("text-xs text-muted-foreground", el("dividerText"))}>{t("common.or")}</span>
      <Separator className={cn("flex-1", el("dividerLine"))} />
    </div>
  );
}

export function FooterSwitch({
  text,
  actionLabel,
  onClick,
}: {
  text: string;
  actionLabel: string;
  onClick: () => void;
}) {
  const { el } = useElementClasses();
  return (
    <p className={cn("flex items-center justify-center gap-1 text-sm", el("footerAction"))}>
      <span className={cn("text-muted-foreground", el("footerActionText"))}>{text}</span>
      <Button
        type="button"
        variant="link"
        size="sm"
        onClick={onClick}
        className={cn("h-auto min-h-6 px-0 py-1 text-sm font-medium", el("footerActionLink"))}
      >
        {actionLabel}
      </Button>
    </p>
  );
}

export function LinkButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button type="button" variant="link" size="sm" onClick={onClick} className="h-auto min-h-6 px-0 py-1 text-sm font-medium">
      {label}
    </Button>
  );
}

export function IdentifierPreview({ value, onEdit }: { value: string; onEdit: () => void }) {
  const { t } = useAuthRuntime();
  const { el } = useElementClasses();
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm",
        el("identityPreview"),
      )}
    >
      <span className={cn("truncate", el("identityPreviewText"))}>{value}</span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onEdit}
        className={cn("h-7 px-2 text-xs", el("identityPreviewEditButton"))}
      >
        {t("common.edit")}
      </Button>
    </div>
  );
}

export function identifierLabel(
  t: TranslateFn,
  identifiers: readonly string[],
): string {
  if (identifiers.length === 1) {
    if (identifiers[0] === "email_address") return t("formFieldLabel__emailAddress");
    if (identifiers[0] === "phone_number") return t("formFieldLabel__phoneNumber");
    if (identifiers[0] === "username") return t("formFieldLabel__username");
  }
  return t("signIn.start.identifierLabel");
}

export function identifierInputType(identifiers: readonly string[]): string {
  if (identifiers.length === 1 && identifiers[0] === "email_address") return "email";
  if (identifiers.length === 1 && identifiers[0] === "phone_number") return "tel";
  return "text";
}

export function identifierAutoComplete(identifiers: readonly string[]): string {
  if (identifiers.length === 1 && identifiers[0] === "phone_number") return "tel";
  if (identifiers.length === 1 && identifiers[0] === "username") return "username";
  return "username";
}

export function useConditionalPasskey(flow: SignInFlow, enabled: boolean) {
  const flowRef = useRef(flow);
  flowRef.current = flow;
  const started = useRef(false);

  useEffect(() => {
    if (!enabled || started.current || typeof window === "undefined") return;
    const credential = Reflect.get(window, "PublicKeyCredential");
    if (typeof credential !== "function") return;
    const isAvailable = Reflect.get(credential, "isConditionalMediationAvailable");
    if (typeof isAvailable !== "function") return;
    started.current = true;
    void (isAvailable as () => Promise<boolean>)
      .call(credential)
      .then((available) => {
        if (available) void flowRef.current.authenticateWithPasskey({ autofill: true });
      })
      .catch(() => undefined);
  }, [enabled]);
}

export function factorIdentifier(signIn: SignInResource | null): string {
  const factors = factorsOf(signIn, "first");
  const withIdentifier = factors.find((factor) => factor.safe_identifier);
  return withIdentifier?.safe_identifier ?? signIn?.identifier ?? "";
}

export function PasskeyButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  const { t } = useAuthRuntime();
  return (
    <Button type="button" variant="outline" className="w-full gap-2" disabled={disabled} onClick={onClick}>
      <FingerprintIcon className="size-4" aria-hidden="true" />
      {t("signIn.passkey.button")}
    </Button>
  );
}
