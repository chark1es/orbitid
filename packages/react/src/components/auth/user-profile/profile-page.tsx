import { ProfileSection, ProfileSectionTitle } from "./security-shared";
import { useState } from "react";
import { Badge, Button, Separator, cn } from "@orbitid/ui";
import { MailIcon, PhoneIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { currentUser, findEmail, findPhone, reloadOrbit } from "../_shared/api";
import { useElementClasses } from "../_shared/appearance";
import { ConfirmDialog } from "../_shared/confirm-dialog";
import { FormError } from "../_shared/form-error";
import { ProviderIcon } from "../_shared/provider-icon";
import { useReverification } from "../../../hooks";
import {
  useAuthRuntime,
  type EmailAddressResource,
  type ExternalAccountResource,
  type PhoneNumberResource,
} from "../_shared/w6";
import {
  emailVerificationStatus,
  providerDisplayName,
  messageFor,
  ProfileImageEditor,
  ProfileForm,
} from "./profile-parts";
import { EmailAddressDialog, PhoneNumberDialog } from "./email-phone-dialogs";
import { ConnectAccountDialog, EnterpriseAccountsSection } from "./connect-account";

export function ProfilePage() {
  const runtime = useAuthRuntime();
  const { orbit, t, environment } = runtime;
  const { ep } = useElementClasses();
  const user = currentUser(orbit);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [emailDialog, setEmailDialog] = useState<{ open: boolean; email?: EmailAddressResource }>({ open: false });
  const [phoneDialog, setPhoneDialog] = useState<{ open: boolean; phone?: PhoneNumberResource }>({ open: false });
  const [removeTarget, setRemoveTarget] = useState<
    { kind: "email" | "phone"; id: string; identifier: string } | null
  >(null);
  const [connectProvider, setConnectProvider] = useState<string | null>(null);
  const [disconnectTarget, setDisconnectTarget] = useState<ExternalAccountResource | null>(null);
  const withVerification = useReverification(async (action: () => Promise<unknown>) => action());

  const refresh = async () => {
    await reloadOrbit(orbit);
    runtime.refresh();
  };

  const runAction = async (action: () => Promise<unknown>, success?: string) => {
    setError(null);
    setNotice(null);
    try {
      await withVerification(action);
      await refresh();
      if (success) setNotice(success);
    } catch (caught) {
      setError(messageFor(t, caught));
    }
  };

  if (!user) {
    return <p className="text-sm text-muted-foreground">{t("userProfile.profile.noUser")}</p>;
  }

  const emails = user.email_addresses ?? [];
  const phones = user.phone_numbers ?? [];
  const external_accounts = user.external_accounts ?? [];
  const connectedProviders = new Set(external_accounts.map((account) => account.provider.replace(/^oauth_/, "")));
  const availableProviders = environment.social.filter((provider) => !connectedProviders.has(provider.id));

  return (
    <div className="flex flex-col gap-6">
      <FormError message={error} />
      {notice ? (
        <p role="status" className="rounded-md border border-go/20 bg-go/10 px-3 py-2 text-sm text-foreground">
          {notice}
        </p>
      ) : null}

      <ProfileSection id="profile" className="flex flex-col gap-4">
        <div>
          <ProfileSectionTitle>{t("userProfile.profile.title")}</ProfileSectionTitle>
          <p className="text-xs text-muted-foreground">{t("userProfile.profile.description")}</p>
        </div>
        <ProfileImageEditor user={user} onChanged={refresh} onError={(caught) => setError(messageFor(t, caught))} />
        <Separator />
        <ProfileForm user={user} onSaved={() => void runAction(async () => undefined, t("userProfile.profile.saved"))} onError={(caught) => setError(messageFor(t, caught))} />
      </ProfileSection>

      <Separator />

      <ProfileSection id="emails" className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <ProfileSectionTitle>{t("userProfile.emailAddresses.title")}</ProfileSectionTitle>
            <p className="text-xs text-muted-foreground">{t("userProfile.emailAddresses.description")}</p>
          </div>
          <Button type="button" variant="outline" size="sm" {...ep("profileSectionPrimaryButton", "gap-1.5")} onClick={() => setEmailDialog({ open: true })}>
            <PlusIcon className="size-4" aria-hidden="true" />
            {t("userProfile.emailAddresses.add")}
          </Button>
        </div>
        <ul className="flex flex-col divide-y rounded-md border">
          {emails.map((email) => {
            const verified = emailVerificationStatus(email) === "verified";
            const isPrimary = user.primary_email_address_id === email.id;
            return (
              <li key={email.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5" data-testid={`email-${email.email_address}`}>
                <MailIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-sm">{email.email_address}</span>
                {isPrimary ? <Badge variant="secondary">{t("common.primary")}</Badge> : null}
                <Badge variant={verified ? "outline" : "destructive"}>
                  {verified ? t("userProfile.emailAddresses.verified") : t("userProfile.emailAddresses.unverified")}
                </Badge>
                {!verified ? (
                  <Button type="button" variant="link" size="sm" className="h-auto min-h-6 px-0 py-1" onClick={() => setEmailDialog({ open: true, email })}>
                    {t("common.verify")}
                  </Button>
                ) : null}
                {!isPrimary && verified ? (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto min-h-6 px-0 py-1"
                    onClick={() => void runAction(() => user.update?.({ primaryEmailAddressId: email.id }) ?? Promise.resolve())}
                  >
                    {t("userProfile.emailAddresses.setPrimary")}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground"
                  aria-label={t("userProfile.emailAddresses.remove")}
                  disabled={emails.length <= 1}
                  onClick={() => setRemoveTarget({ kind: "email", id: email.id, identifier: email.email_address })}
                >
                  <Trash2Icon className="size-4" />
                </Button>
              </li>
            );
          })}
        </ul>
      </ProfileSection>

      <ProfileSection id="phones" className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <ProfileSectionTitle>{t("userProfile.phoneNumbers.title")}</ProfileSectionTitle>
            <p className="text-xs text-muted-foreground">{t("userProfile.phoneNumbers.description")}</p>
          </div>
          {environment.attributes.phone_number.enabled ? (
            <Button type="button" variant="outline" size="sm" {...ep("profileSectionPrimaryButton", "gap-1.5")} onClick={() => setPhoneDialog({ open: true })}>
              <PlusIcon className="size-4" aria-hidden="true" />
              {t("userProfile.phoneNumbers.add")}
            </Button>
          ) : null}
        </div>
        {phones.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("userProfile.mfaPhones.none")}</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-md border">
            {phones.map((phone) => {
              const verified = emailVerificationStatus(phone) === "verified";
              const isPrimary = user.primary_phone_number_id === phone.id;
              return (
                <li key={phone.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                  <PhoneIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-sm">{phone.phone_number}</span>
                  {isPrimary ? <Badge variant="secondary">{t("common.primary")}</Badge> : null}
                  {phone.reserved_for_second_factor ? <Badge variant="outline">{t("userProfile.mfaPhones.default")}</Badge> : null}
                  {!verified ? (
                    <Button type="button" variant="link" size="sm" className="h-auto min-h-6 px-0 py-1" onClick={() => setPhoneDialog({ open: true, phone })}>
                      {t("common.verify")}
                    </Button>
                  ) : null}
                  {!isPrimary && verified ? (
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="h-auto min-h-6 px-0 py-1"
                      onClick={() => void runAction(() => user.update?.({ primaryPhoneNumberId: phone.id }) ?? Promise.resolve())}
                    >
                      {t("userProfile.phoneNumbers.setPrimary")}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground"
                    aria-label={t("userProfile.phoneNumbers.remove")}
                    disabled={environment.attributes.phone_number.required && phones.length <= 1}
                    onClick={() => setRemoveTarget({ kind: "phone", id: phone.id, identifier: phone.phone_number })}
                  >
                    <Trash2Icon className="size-4" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </ProfileSection>

      <ProfileSection id="connected-accounts" className="flex flex-col gap-3">
        <div>
          <ProfileSectionTitle>{t("userProfile.connectedAccounts.title")}</ProfileSectionTitle>
          <p className="text-xs text-muted-foreground">{t("userProfile.connectedAccounts.description")}</p>
        </div>
        {external_accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("userProfile.connectedAccounts.none")}</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-md border">
            {external_accounts.map((account) => (
              <li key={account.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                <ProviderIcon provider={account.provider} className="size-5" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{providerDisplayName(account.provider)}</p>
                  <p className="truncate text-xs text-muted-foreground">{account.email_address || account.username || account.approved_scopes}</p>
                </div>
                <Badge variant="outline">{t("userProfile.connectedAccounts.connected")}</Badge>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto min-h-6 px-0 py-1"
                  onClick={() => setConnectProvider(account.provider.replace(/^oauth_/, ""))}
                >
                  {t("userProfile.connectedAccounts.reconnect")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground"
                  aria-label={`${t("userProfile.connectedAccounts.disconnect")} ${providerDisplayName(account.provider)}`}
                  onClick={() => setDisconnectTarget(account)}
                >
                  <Trash2Icon className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        {availableProviders.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {availableProviders.map((provider) => (
              <Button
                key={provider.id}
                type="button"
                variant="outline"
                size="sm"
                className="max-w-full gap-2"
                onClick={() => setConnectProvider(provider.id)}
              >
                <ProviderIcon provider={provider.id} />
                <span className="min-w-0 truncate">{provider.name}</span>
              </Button>
            ))}
          </div>
        ) : null}
      </ProfileSection>

      <EnterpriseAccountsSection />

      <EmailAddressDialog
        open={emailDialog.open}
        email={emailDialog.email}
        user={user}
        onOpenChange={(open) => setEmailDialog({ open })}
        onError={(caught) => setError(messageFor(t, caught))}
        onVerified={() => void runAction(async () => undefined, t("userProfile.emailAddresses.verifiedToast"))}
      />
      <PhoneNumberDialog
        open={phoneDialog.open}
        phone={phoneDialog.phone}
        user={user}
        onOpenChange={(open) => setPhoneDialog({ open })}
        onError={(caught) => setError(messageFor(t, caught))}
        onVerified={() => void runAction(async () => undefined, t("userProfile.emailAddresses.verifiedToast"))}
      />
      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
        title={
          removeTarget?.kind === "email"
            ? t("userProfile.emailAddresses.remove")
            : t("userProfile.phoneNumbers.remove")
        }
        description={
          removeTarget
            ? removeTarget.kind === "email"
              ? t("userProfile.emailAddresses.removeConfirm", { identifier: removeTarget.identifier })
              : t("userProfile.phoneNumbers.removeConfirm", { identifier: removeTarget.identifier })
            : undefined
        }
        onConfirm={() => {
          const target = removeTarget;
          setRemoveTarget(null);
          if (!target) return;
          if (target.kind === "email") {
            const resource = findEmail(user, target.id);
            void runAction(async () => {
              if (!resource?.destroy) throw new Error(t("common.internalError"));
              await resource.destroy();
            });
          } else {
            const resource = findPhone(user, target.id);
            void runAction(async () => {
              if (!resource?.destroy) throw new Error(t("common.internalError"));
              await resource.destroy();
            });
          }
        }}
      />
      <ConnectAccountDialog
        open={connectProvider !== null}
        provider={connectProvider}
        onOpenChange={(open) => {
          if (!open) setConnectProvider(null);
        }}
        onError={(caught) => setError(messageFor(t, caught))}
      />
      <ConfirmDialog
        open={disconnectTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDisconnectTarget(null);
        }}
        title={t("userProfile.connectedAccounts.disconnect")}
        description={
          disconnectTarget
            ? t("userProfile.connectedAccounts.disconnectConfirm", {
                provider: providerDisplayName(disconnectTarget.provider),
              })
            : undefined
        }
        destructive
        onConfirm={() => {
          const account = disconnectTarget;
          setDisconnectTarget(null);
          if (!account) return;
          void runAction(async () => {
            if (!account.destroy) throw new Error(t("common.internalError"));
            await account.destroy();
          });
        }}
      />
    </div>
  );
}
