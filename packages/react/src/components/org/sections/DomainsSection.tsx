import { useEffect, useState } from "react";
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
  Separator,
} from "@orbitid/ui";
import { PlusIcon, ShieldCheckIcon, Trash2Icon } from "lucide-react";
import { useLocalizations } from "../../../localization";
import type {
  OrganizationDomainResource,
  OrganizationResource,
} from "../../../provider";
import { ConfirmDialog } from "../_shared/ConfirmDialog";
import { EmptyState, ErrorBanner, LoadingRows } from "../_shared/Feedback";
import { useAsyncAction, useOrgErrorText, type OrgScope } from "../_shared/hooks";
import { isValidDomain } from "../_shared/utils";

const ENROLLMENT_MODES = [
  "manual_invitation",
  "automatic_invitation",
  "automatic_suggestion",
] as const;

type EnrollmentMode = (typeof ENROLLMENT_MODES)[number];

export interface DomainsSectionProps {
  organization: OrganizationResource;
  domains: OrgScope["domains"];
  canManage: boolean;
}

/** Verified domains: add, verify via affiliation email code, enrollment mode, delete. */
export function DomainsSection({ organization, domains, canManage }: DomainsSectionProps) {
  const { t } = useLocalizations();
  const [domainName, setDomainName] = useState("");
  const [domainError, setDomainError] = useState<string | null>(null);
  const [verifyDomain, setVerifyDomain] = useState<OrganizationDomainResource | null>(null);
  const [deleteDomain, setDeleteDomain] = useState<OrganizationDomainResource | null>(null);

  const addAction = useAsyncAction(async (name: string) => {
    const created = await organization.createDomain({ name });
    await domains.revalidate();
    return created;
  });
  const deleteAction = useAsyncAction(async (domain: OrganizationDomainResource) => {
    await domain.delete();
    await domains.revalidate();
    return true;
  });
  const enrollmentAction = useAsyncAction(
    async (domain: OrganizationDomainResource, mode: EnrollmentMode, deletePending: boolean) => {
      await domain.updateEnrollmentMode({ enrollmentMode: mode, deletePending });
      await domains.revalidate();
    },
  );
  const addError = useOrgErrorText(addAction.error);
  const deleteError = useOrgErrorText(deleteAction.error);
  const enrollmentError = useOrgErrorText(enrollmentAction.error);
  const listError = useOrgErrorText(domains.error);

  const submitDomain = async () => {
    const name = domainName.trim().toLowerCase();
    if (!isValidDomain(name)) {
      setDomainError(t("formFieldError__domainInvalid"));
      return;
    }
    setDomainError(null);
    const created = await addAction.run(name);
    if (created !== undefined) setDomainName("");
  };

  return (
    <section className="flex flex-col gap-3" aria-label={t("organizationProfile.domainsSection.title")}>
      <div className="flex flex-col gap-1">
        <h3 className="font-medium">{t("organizationProfile.domainsSection.title")}</h3>
        <p className="text-sm text-muted-foreground">
          {t("organizationProfile.domainsSection.subtitle")}
        </p>
      </div>

      {canManage ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submitDomain();
          }}
        >
          <div className="flex min-w-[12rem] flex-1 flex-col gap-1.5">
            <Label htmlFor="add-domain">{t("formFieldLabel__organizationDomain")}</Label>
            <Input
              id="add-domain"
              value={domainName}
              autoComplete="off"
              placeholder={t("formFieldInputPlaceholder__organizationDomain")}
              aria-invalid={domainError ? true : undefined}
              onChange={(event) => setDomainName(event.target.value)}
            />
          </div>
          <Button type="submit" variant="outline" disabled={addAction.isPending}>
            <PlusIcon aria-hidden="true" />
            {t("organizationProfile.domainsSection.addDomainButton")}
          </Button>
        </form>
      ) : null}

      {domainError ? (
        <p className="text-sm text-destructive" role="alert">
          {domainError}
        </p>
      ) : null}
      <ErrorBanner message={addError} />
      <ErrorBanner message={deleteError} />
      <ErrorBanner message={enrollmentError} />
      <ErrorBanner message={listError} onRetry={() => void domains.revalidate()} />

      {domains.isLoading ? (
        <LoadingRows rows={2} />
      ) : domains.data.length === 0 ? (
        <EmptyState>{t("organizationProfile.domainsSection.noDomains")}</EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          {domains.data.map((domain) => (
            <DomainCard
              key={domain.id}
              domain={domain}
              canManage={canManage}
              busy={enrollmentAction.isPending || deleteAction.isPending}
              onVerify={() => setVerifyDomain(domain)}
              onDelete={() => setDeleteDomain(domain)}
              onSaveEnrollment={(mode, deletePending) =>
                void enrollmentAction.run(domain, mode, deletePending)
              }
            />
          ))}
        </div>
      )}

      <VerifyDomainDialog
        domain={verifyDomain}
        onOpenChange={(open) => {
          if (!open) setVerifyDomain(null);
        }}
        onVerified={() => {
          setVerifyDomain(null);
          void domains.revalidate();
        }}
      />

      <ConfirmDialog
        open={deleteDomain !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteDomain(null);
        }}
        title={t("organizationProfile.domainsSection.removeDomainTitle")}
        description={t("organizationProfile.domainsSection.removeDomainSubtitle")}
        confirmLabel={t("organizationProfile.domainsSection.removeDomain")}
        destructive
        error={deleteError}
        onConfirm={async () => {
          if (!deleteDomain) return;
          const deleted = await deleteAction.run(deleteDomain);
          if (deleted) setDeleteDomain(null);
        }}
      />
    </section>
  );
}

interface DomainCardProps {
  domain: OrganizationDomainResource;
  canManage: boolean;
  busy: boolean;
  onVerify: () => void;
  onDelete: () => void;
  onSaveEnrollment: (mode: EnrollmentMode, deletePending: boolean) => void;
}

function DomainCard({
  domain,
  canManage,
  busy,
  onVerify,
  onDelete,
  onSaveEnrollment,
}: DomainCardProps) {
  const { t } = useLocalizations();
  const initialMode = (ENROLLMENT_MODES as readonly string[]).includes(domain.enrollmentMode)
    ? (domain.enrollmentMode as EnrollmentMode)
    : "manual_invitation";
  const [mode, setMode] = useState<EnrollmentMode>(initialMode);
  const [deletePending, setDeletePending] = useState(false);

  useEffect(() => {
    setMode(initialMode);
  }, [initialMode, domain.id]);

  const verified = domain.verification?.status === "verified";
  const changed = mode !== initialMode || deletePending;

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3" data-testid={`domain-${domain.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-medium">{domain.name}</span>
          <Badge variant={verified ? "secondary" : "outline"}>
            {verified
              ? t("organizationProfile.domainsSection.verifiedDomain")
              : t("organizationProfile.domainsSection.pendingVerification")}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          {!verified && canManage ? (
            <Button type="button" size="xs" variant="outline" onClick={onVerify} disabled={busy}>
              <ShieldCheckIcon aria-hidden="true" />
              {t("organizationProfile.domainsSection.verifyDomain")}
            </Button>
          ) : null}
          {canManage ? (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={`${t("organizationProfile.domainsSection.removeDomain")} ${domain.name}`}
              onClick={onDelete}
              disabled={busy}
            >
              <Trash2Icon aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </div>

      {domain.totalPendingInvitations || domain.totalPendingSuggestions ? (
        <p className="text-xs text-muted-foreground">
          {t("organizationProfile.domainsSection.pendingCounts", {
            invitations: domain.totalPendingInvitations ?? 0,
            suggestions: domain.totalPendingSuggestions ?? 0,
          })}
        </p>
      ) : null}

      <Separator />

      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">
          {t("organizationProfile.domainsSection.enrollmentModeLabel")}
        </p>
        <RadioGroup
          value={mode}
          onValueChange={(value) => setMode(value as EnrollmentMode)}
          disabled={!canManage || busy}
          className="flex flex-col gap-2 sm:flex-row sm:flex-wrap"
        >
          {ENROLLMENT_MODES.map((option) => (
            <div key={option} className="flex items-center gap-2">
              <RadioGroupItem value={option} id={`${domain.id}-${option}`} />
              <Label htmlFor={`${domain.id}-${option}`} className="font-normal">
                {t(`organizationProfile.domainsSection.enrollmentMode__${option}`)}
              </Label>
            </div>
          ))}
        </RadioGroup>
        {mode !== "manual_invitation" && canManage ? (
          <div className="flex items-center gap-2">
            <Checkbox
              id={`${domain.id}-delete-pending`}
              checked={deletePending}
              onCheckedChange={(checked) => setDeletePending(checked === true)}
              disabled={busy}
            />
            <Label htmlFor={`${domain.id}-delete-pending`} className="font-normal">
              {t("organizationProfile.domainsSection.enrollmentModeDeletePending")}
            </Label>
          </div>
        ) : null}
        {canManage ? (
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!changed || busy}
              onClick={() => onSaveEnrollment(mode, deletePending)}
            >
              {t("organizationProfile.domainsSection.enrollmentModeUpdate")}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

interface VerifyDomainDialogProps {
  domain: OrganizationDomainResource | null;
  onOpenChange: (open: boolean) => void;
  onVerified: () => void;
}

function VerifyDomainDialog({ domain, onOpenChange, onVerified }: VerifyDomainDialogProps) {
  const { t } = useLocalizations();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [sentTo, setSentTo] = useState("");

  useEffect(() => {
    if (domain) {
      setStep("email");
      setEmail("");
      setCode("");
      setSentTo("");
    }
  }, [domain?.id]);

  const prepareAction = useAsyncAction(async (target: OrganizationDomainResource, address: string) => {
    await target.prepareAffiliationVerification({ affiliationEmailAddress: address });
    setSentTo(address);
    setStep("code");
  });
  const attemptAction = useAsyncAction(async (target: OrganizationDomainResource, value: string) => {
    await target.attemptAffiliationVerification({ code: value });
    onVerified();
  });
  const prepareError = useOrgErrorText(prepareAction.error);
  const attemptError = useOrgErrorText(attemptAction.error);

  const suffix = domain ? `@${domain.name.toLowerCase()}` : "";
  const emailValid =
    email.trim().length > 0 &&
    (!suffix || email.trim().toLowerCase().endsWith(suffix));

  return (
    <Dialog open={domain !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("organizationProfile.domainsSection.verifyDomainTitle", { domain: domain?.name ?? "" })}
          </DialogTitle>
          <DialogDescription>
            {t("organizationProfile.domainsSection.verifyDomainSubtitle")}
          </DialogDescription>
        </DialogHeader>

        {step === "email" ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="affiliation-email">
                {t("formFieldLabel__organizationDomainEmailAddress")}
              </Label>
              <Input
                id="affiliation-email"
                type="email"
                value={email}
                autoComplete="email"
                placeholder={t("formFieldInputPlaceholder__organizationDomainEmailAddress")}
                aria-invalid={email.length > 0 && !emailValid ? true : undefined}
                onChange={(event) => setEmail(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t("organizationProfile.domainsSection.emailHint", { domain: domain?.name ?? "" })}
              </p>
            </div>
            <ErrorBanner message={prepareError} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t("formButtonReset")}
              </Button>
              <Button
                type="button"
                disabled={!emailValid || prepareAction.isPending || !domain}
                onClick={() => {
                  if (domain) void prepareAction.run(domain, email.trim());
                }}
              >
                {t("organizationProfile.domainsSection.sendCode")}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              {t("organizationProfile.domainsSection.codeSent", { email: sentTo })}
            </p>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="affiliation-code">{t("formFieldLabel__code")}</Label>
              <Input
                id="affiliation-code"
                value={code}
                inputMode="numeric"
                autoComplete="one-time-code"
                onChange={(event) => setCode(event.target.value)}
              />
            </div>
            <ErrorBanner message={attemptError} />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setStep("email")}
                disabled={attemptAction.isPending}
              >
                {t("backButton")}
              </Button>
              <Button
                type="button"
                disabled={code.trim().length === 0 || attemptAction.isPending || !domain}
                onClick={() => {
                  if (domain) void attemptAction.run(domain, code.trim());
                }}
              >
                {t("organizationProfile.domainsSection.verifyDomain")}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
