import { useState } from "react";
import { Separator } from "@orbitid/ui";
import { currentUser, reloadOrbit } from "../_shared/api";
import { FormError } from "../_shared/form-error";
import { messageFor } from "./profile-parts";
import { useAuthRuntime } from "../_shared/w6";
import { PasswordSection, PasskeysSection } from "./security-credentials";
import { TotpSection, BackupCodesSection, MfaPhonesSection } from "./security-mfa";
import { TrustedDevicesSection, DevicesSection, DeleteAccountSection } from "./security-devices";
import { type SectionProps } from "./security-shared";

export function SecurityPage({ onNavigate }: { onNavigate: (page: string) => void }) {
  const runtime = useAuthRuntime();
  const { orbit, t } = runtime;
  const user = currentUser(orbit);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = async () => {
    await reloadOrbit(orbit);
    runtime.refresh();
  };

  if (!user) {
    return <p className="text-sm text-muted-foreground">{t("userProfile.profile.noUser")}</p>;
  }

  const sectionProps: SectionProps = {
    user,
    refresh,
    onError: (caught) => setError(messageFor(t, caught)),
    onNotice: (message) => {
      setError(null);
      setNotice(message);
    },
  };

  return (
    <div className="flex flex-col gap-6">
      <FormError message={error} />
      {notice ? (
        <p role="status" className="rounded-md border border-go/20 bg-go/10 px-3 py-2 text-sm text-foreground">
          {notice}
        </p>
      ) : null}
      <PasswordSection {...sectionProps} />
      <Separator />
      <PasskeysSection {...sectionProps} />
      <Separator />
      <TotpSection {...sectionProps} />
      <Separator />
      <BackupCodesSection {...sectionProps} />
      <Separator />
      <MfaPhonesSection {...sectionProps} />
      <Separator />
      <TrustedDevicesSection {...sectionProps} />
      <Separator />
      <DevicesSection {...sectionProps} />
      <Separator />
      <DeleteAccountSection {...sectionProps} onDeleted={() => onNavigate("profile")} />
    </div>
  );
}
