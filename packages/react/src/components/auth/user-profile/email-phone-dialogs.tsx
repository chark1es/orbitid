import { useEffect, useState } from "react";
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
} from "@orbitid/ui";
import {
  attemptEmailVerification,
  attemptPhoneVerification,
  prepareEmailVerification,
  preparePhoneVerification,
} from "../_shared/api";
import { FormError } from "../_shared/form-error";
import { OtpField } from "../_shared/otp-field";
import { PhoneInput } from "../_shared/phone-input";
import { normalizePhone } from "../_shared/normalize";
import {
  useAuthRuntime,
  type EmailAddressResource,
  type OrbitUser,
  type PhoneNumberResource,
} from "../_shared/w6";
import { messageFor } from "./profile-parts";

export function EmailAddressDialog({
  open,
  email,
  user,
  onOpenChange,
  onVerified,
  onError,
}: {
  open: boolean;
  email?: EmailAddressResource;
  user: OrbitUser;
  onOpenChange: (open: boolean) => void;
  onVerified: () => void;
  onError: (caught: unknown) => void;
}) {
  const runtime = useAuthRuntime();
  const { t } = runtime;
  const [resource, setResource] = useState<EmailAddressResource | undefined>(email);
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<"add" | "verify">(email ? "verify" : "add");
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setResource(email);
    setStage(email ? "verify" : "add");
    setAddress(email?.email_address ?? "");
    setCode("");
    setDialogError(null);
    if (email) {
      void prepareEmailVerification(email).catch((caught) => onError(caught));
    }
  }, [open, email]);

  const add = async () => {
    if (!address.trim()) return;
    setBusy(true);
    setDialogError(null);
    try {
      if (!user.createEmailAddress) throw new Error(t("common.internalError"));
      const created = await user.createEmailAddress({ email: address.trim() });
      setResource(created);
      await prepareEmailVerification(created);
      setStage("verify");
    } catch (caught) {
      setDialogError(messageFor(t, caught));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (value: string) => {
    if (!resource) return;
    setBusy(true);
    setDialogError(null);
    try {
      await attemptEmailVerification(resource, value);
      onOpenChange(false);
      onVerified();
    } catch (caught) {
      setDialogError(messageFor(t, caught));
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {stage === "add" ? t("userProfile.emailAddresses.add") : t("userProfile.emailAddresses.verifyTitle")}
          </DialogTitle>
          <DialogDescription>
            {stage === "verify"
              ? t("userProfile.emailAddresses.verifySubtitle", { identifier: resource?.email_address ?? address })
              : t("userProfile.emailAddresses.description")}
          </DialogDescription>
        </DialogHeader>
        <FormError message={dialogError} />
        {stage === "add" ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void add();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-email">{t("formFieldLabel__emailAddress")}</Label>
              <Input
                id="new-email"
                type="email"
                autoComplete="email"
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                placeholder={t("formFieldPlaceholder__emailAddress")}
                autoFocus
                disabled={busy}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={busy || !address.trim()}>
                {t("common.add")}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="flex flex-col gap-3">
            <OtpField
              value={code}
              onChange={setCode}
              onComplete={(value) => void verify(value)}
              label={t("formFieldLabel__code")}
              disabled={busy}
              autoFocus
            />
            <div className="flex justify-between">
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0"
                disabled={busy}
                onClick={() => void (resource ? prepareEmailVerification(resource) : Promise.resolve())}
              >
                {t("common.resend")}
              </Button>
              <Button type="button" disabled={busy || code.length < 6} onClick={() => void verify(code)}>
                {t("common.verify")}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function PhoneNumberDialog({
  open,
  phone,
  user,
  onOpenChange,
  onVerified,
  onError,
  reservedForSecondFactor = false,
}: {
  open: boolean;
  phone?: PhoneNumberResource;
  user: OrbitUser;
  onOpenChange: (open: boolean) => void;
  onVerified: () => void;
  onError: (caught: unknown) => void;
  reservedForSecondFactor?: boolean;
}) {
  const runtime = useAuthRuntime();
  const { t } = runtime;
  const [resource, setResource] = useState<PhoneNumberResource | undefined>(phone);
  const [number, setNumber] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<"add" | "verify">(phone ? "verify" : "add");
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setResource(phone);
    setStage(phone ? "verify" : "add");
    setNumber(phone?.phone_number ?? "");
    setCode("");
    setDialogError(null);
    if (phone) void preparePhoneVerification(phone).catch((caught) => onError(caught));
  }, [open, phone]);

  const add = async () => {
    if (!number.trim()) return;
    setBusy(true);
    setDialogError(null);
    try {
      if (!user.createPhoneNumber) throw new Error(t("common.internalError"));
      const created = await user.createPhoneNumber({ phoneNumber: number.trim() });
      const normalizedPhone = normalizePhone(created);
      if (reservedForSecondFactor) await normalizedPhone?.update?.({ reservedForSecondFactor: true });
      setResource(normalizedPhone ?? created);
      await preparePhoneVerification(created);
      setStage("verify");
    } catch (caught) {
      setDialogError(messageFor(t, caught));
      onError(caught);
    } finally {
      setBusy(false);
    }
  };

  const verify = async (value: string) => {
    if (!resource) return;
    setBusy(true);
    setDialogError(null);
    try {
      await attemptPhoneVerification(resource, value);
      onOpenChange(false);
      onVerified();
    } catch (caught) {
      setDialogError(messageFor(t, caught));
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {stage === "add" ? t("userProfile.phoneNumbers.add") : t("userProfile.phoneNumbers.verifyTitle")}
          </DialogTitle>
          <DialogDescription>
            {stage === "verify"
              ? t("userProfile.phoneNumbers.verifySubtitle", { identifier: resource?.phone_number ?? number })
              : t("userProfile.phoneNumbers.description")}
          </DialogDescription>
        </DialogHeader>
        <FormError message={dialogError} />
        {stage === "add" ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void add();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label>{t("formFieldLabel__phoneNumber")}</Label>
              <PhoneInput value={number} onChange={setNumber} disabled={busy} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={busy || !number.trim()}>
                {t("common.add")}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="flex flex-col gap-3">
            <OtpField
              value={code}
              onChange={setCode}
              onComplete={(value) => void verify(value)}
              label={t("formFieldLabel__code")}
              disabled={busy}
              autoFocus
            />
            <div className="flex justify-between">
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0"
                disabled={busy}
                onClick={() => void (resource ? preparePhoneVerification(resource) : Promise.resolve())}
              >
                {t("common.resend")}
              </Button>
              <Button type="button" disabled={busy || code.length < 6} onClick={() => void verify(code)}>
                {t("common.verify")}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
