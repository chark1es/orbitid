import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, Button, Input, Label } from "@orbitid/ui";
import { UploadIcon } from "lucide-react";
import { useLocalizations } from "../../localization";
import { getErrorCode } from "../../lib/errors";
import { useRouter } from "../../lib/routing";
import type { OrganizationResource } from "../../provider";
import { EmailChipsInput } from "./_shared/EmailChipsInput";
import { ErrorBanner, FieldError } from "./_shared/Feedback";
import { OrgAvatar } from "./_shared/OrgAvatar";
import { OrgRoot } from "./_shared/OrgRoot";
import { RoleSelect } from "./_shared/RoleSelect";
import {
  useAsyncAction,
  useNavigate,
  useOrganizationCreator,
  useOrganizationRoles,
  useOrgErrorText,
  useOrgSettings,
} from "./_shared/hooks";
import { fillUrlTemplate, readFileAsDataUrl, resolveRedirect, slugify } from "./_shared/utils";
import type { CommonOrgProps, RedirectUrl } from "./_shared/types";

export interface CreateOrganizationProps extends CommonOrgProps {
  /** Where to send the user after creation (supports `:id`/`:slug` templates). */
  afterCreateOrganizationUrl?: RedirectUrl<OrganizationResource>;
  /** Skip the invite-members step. */
  skipInvitationScreen?: boolean;
  /** Step routing (`path`, `hash` or in-memory). */
  routing?: "path" | "hash" | "virtual";
  /** Base path for `routing="path"`. */
  path?: string;
  /** Called once the flow completes (modal hosts); replaces navigation. */
  onCreated?: (organization: OrganizationResource) => void;
}

/** Two-step organization creation: details (name/slug/logo) then optional member invites. */
export function CreateOrganization(props: CreateOrganizationProps) {
  return (
    <OrgRoot appearance={props.appearance} className={props.className}>
      <CreateOrganizationView {...props} />
    </OrgRoot>
  );
}

function CreateOrganizationView({
  afterCreateOrganizationUrl,
  skipInvitationScreen,
  routing = "virtual",
  path,
  onCreated,
}: CreateOrganizationProps) {
  const { t } = useLocalizations();
  const navigate = useNavigate();
  const router = useRouter({ routing, path, startPath: "/details" });
  const settings = useOrgSettings();
  const { createOrganization, setActive } = useOrganizationCreator();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [created, setCreated] = useState<OrganizationResource | null>(null);
  const [emails, setEmails] = useState<string[]>([]);
  const [inviteRole, setInviteRole] = useState(settings.defaultRole);
  const [nameError, setNameError] = useState<string | null>(null);
  const [slugError, setSlugError] = useState<string | null>(null);
  const [formError, setFormError] = useState<unknown>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!slugTouched) setSlug(slugify(name));
  }, [name, slugTouched]);

  useEffect(() => {
    if (!logoFile) {
      setLogoPreview(null);
      return;
    }
    let cancelled = false;
    readFileAsDataUrl(logoFile).then(
      (url) => {
        if (!cancelled) setLogoPreview(url);
      },
      () => setLogoPreview(null),
    );
    return () => {
      cancelled = true;
    };
  }, [logoFile]);

  const createAction = useAsyncAction(async (input: { name: string; slug?: string }) => {
    try {
      return { ok: true as const, organization: await createOrganization(input) };
    } catch (error) {
      return { ok: false as const, error };
    }
  });
  const inviteAction = useAsyncAction(
    async (organization: OrganizationResource, role: string, addresses: string[]) =>
      organization.inviteMembers({ emailAddresses: addresses, role }),
  );
  const logoAction = useAsyncAction((organization: OrganizationResource, file: File) =>
    organization.setLogo({ file }),
  );

  const createError = useOrgErrorText(formError);
  const inviteError = useOrgErrorText(inviteAction.error);
  const logoError = useOrgErrorText(logoAction.error);
  const { roles } = useOrganizationRoles(created);

  const finish = (organization: OrganizationResource) => {
    if (onCreated) {
      onCreated(organization);
      return;
    }
    const url = resolveRedirect(afterCreateOrganizationUrl, organization);
    if (url) navigate(fillUrlTemplate(url, { id: organization.id, slug: organization.slug }));
  };

  const continueAfterDetails = async (organization: OrganizationResource) => {
    if (logoFile) {
      const logo = await logoAction.run(organization, logoFile);
      if (logo === undefined) return;
    }
    if (skipInvitationScreen) finish(organization);
    else router.navigate("/invite");
  };

  const submitDetails = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError(t("unstable__errors.form_param_missing"));
      return;
    }
    setNameError(null);
    setSlugError(null);
    setFormError(null);

    if (created) {
      await continueAfterDetails(created);
      return;
    }

    const outcome = await createAction.run({
      name: trimmed,
      ...(settings.slugEnabled && slug ? { slug } : {}),
    });
    if (!outcome) return;
    if (!outcome.ok) {
      if (getErrorCode(outcome.error) === "organization_slug_taken") {
        setSlugError(t("unstable__errors.organization_slug_taken"));
      } else {
        setFormError(outcome.error);
      }
      return;
    }
    setCreated(outcome.organization);
    await setActive({ organization: outcome.organization });
    await continueAfterDetails(outcome.organization);
  };

  const submitInvites = async () => {
    if (!created) return;
    const invitations = await inviteAction.run(created, inviteRole, emails);
    if (invitations === undefined) return;
    finish(created);
  };

  if (!settings.creationEnabled) {
    return (
      <Alert>
        <AlertDescription>
          {t("unstable__errors.organization_creation_not_allowed")}
        </AlertDescription>
      </Alert>
    );
  }

  const step = created && router.match("/invite") ? "invite" : "details";

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">{t("createOrganization.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("createOrganization.subtitle")}</p>
      </header>

      <ErrorBanner message={createError} />
      <ErrorBanner message={logoError} />

      {step === "details" ? (
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submitDetails();
          }}
        >
          <div className="flex items-center gap-3">
            <OrgAvatar name={name || "?"} imageUrl={logoPreview} size="lg" />
            <div className="flex flex-col gap-1">
              <Label htmlFor="create-org-logo">{t("createOrganization.logoLabel")}</Label>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => logoInputRef.current?.click()}
                >
                  <UploadIcon aria-hidden="true" />
                  {t("formFieldLabel__organizationLogo")}
                </Button>
                {logoFile ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setLogoFile(null);
                      if (logoInputRef.current) logoInputRef.current.value = "";
                    }}
                  >
                    {t("formButtonReset")}
                  </Button>
                ) : null}
              </div>
              <input
                ref={logoInputRef}
                id="create-org-logo"
                type="file"
                accept="image/png,image/jpeg,image/svg+xml,image/webp"
                className="sr-only"
                onChange={(event) => setLogoFile(event.target.files?.[0] ?? null)}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-org-name">{t("formFieldLabel__organizationName")}</Label>
            <Input
              id="create-org-name"
              value={name}
              autoComplete="organization"
              placeholder={t("formFieldInputPlaceholder__organizationName")}
              aria-invalid={nameError ? true : undefined}
              onChange={(event) => setName(event.target.value)}
            />
            <FieldError message={nameError} />
          </div>

          {settings.slugEnabled ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="create-org-slug">{t("formFieldLabel__organizationSlug")}</Label>
              <Input
                id="create-org-slug"
                value={slug}
                autoComplete="off"
                placeholder={t("formFieldInputPlaceholder__organizationSlug")}
                aria-invalid={slugError ? true : undefined}
                onChange={(event) => {
                  setSlugTouched(true);
                  setSlug(slugify(event.target.value));
                }}
              />
              <p className="text-xs text-muted-foreground">{t("createOrganization.slugHint")}</p>
              <FieldError message={slugError} />
            </div>
          ) : null}

          <div className="flex justify-end">
            <Button type="submit" disabled={createAction.isPending || logoAction.isPending}>
              {createAction.isPending ? t("status.loading") : t("createOrganization.formButtonSubmit")}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <OrgAvatar
              name={created?.name ?? name}
              imageUrl={logoPreview ?? created?.imageUrl}
              hasImage={logoPreview ? true : created?.hasImage}
              size="md"
            />
            <div className="flex flex-col">
              <span className="font-medium">{created?.name ?? name}</span>
              <span className="text-xs text-muted-foreground">{created?.slug ?? slug}</span>
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <h3 className="font-medium">{t("createOrganization.inviteTitle")}</h3>
            <p className="text-sm text-muted-foreground">
              {t("createOrganization.inviteSubtitle", { organization: created?.name ?? name })}
            </p>
          </div>
          <EmailChipsInput
            label={t("formFieldLabel__emailAddresses")}
            placeholder={t("formFieldInputPlaceholder__emailAddresses")}
            value={emails}
            onChange={setEmails}
            disabled={inviteAction.isPending}
          />
          <RoleSelect
            label={t("formFieldLabel__role")}
            roles={roles}
            value={inviteRole}
            onChange={setInviteRole}
            size="default"
          />
          <ErrorBanner message={inviteError} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => (created ? finish(created) : undefined)}
            >
              {t("createOrganization.skipButton")}
            </Button>
            <Button
              type="button"
              disabled={inviteAction.isPending || emails.length === 0}
              onClick={() => void submitInvites()}
            >
              {inviteAction.isPending ? t("status.loading") : t("createOrganization.inviteButton")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
