import { useForm } from "react-hook-form";
import { Button, Input, cn } from "@orbitid/ui";
import { FingerprintIcon, Loader2Icon } from "lucide-react";
import { signUpUrlFor } from "../flow";
import { useAuthRuntime } from "../../_shared/w6";
import { useComponentElements } from "../../_shared/appearance";
import { FormError } from "../../_shared/form-error";
import { Field } from "../../_shared/field";
import { SocialButtons } from "../../_shared/social-buttons";
import { IDENTIFIER_STRATEGIES, LastUsedBadge } from "../../_shared/last-used-badge";
import {
  Divider,
  FooterSwitch,
  identifierAutoComplete,
  identifierInputType,
  LinkButton,
  identifierLabel,
  useConditionalPasskey,
  type StepProps,
} from "./shared";

export function StartStep({ flow, props }: StepProps) {
  const runtime = useAuthRuntime();
  const { environment, t, navigate, orbit } = runtime;
  const { ep, appearance } = useComponentElements();
  const form = useForm<{ identifier: string }>({
    defaultValues: { identifier: flow.identifierDraft },
    mode: "onSubmit",
  });
  const hasIdentifiers = environment.identifiers.length > 0;
  // Resetting a password sends a code to an email address, so it needs both a password and an email to send it to.
  const canResetPassword = environment.attributes.password.enabled && environment.attributes.email_address.enabled;
  const passkeyEnabled = environment.attributes.passkey.enabled;
  const socialAtTop = appearance.layout?.socialButtonsPlacement !== "bottom";
  // Remembered per browser by the SDK: a strategy name only, never who signed in.
  const lastUsedStrategy = orbit.lastUsedStrategy ?? null;
  const identifierLastUsed = lastUsedStrategy !== null && IDENTIFIER_STRATEGIES.has(lastUsedStrategy);
  const passkeyLastUsed = lastUsedStrategy === "passkey";

  useConditionalPasskey(flow, passkeyEnabled && environment.passkey.allowAutofill);

  const submit = form.handleSubmit(async (values) => {
    if (!values.identifier.trim()) {
      form.setError("identifier", { message: t("formFieldError__required") });
      return;
    }
    flow.setIdentifierDraft(values.identifier.trim());
    if (!hasIdentifiers) {
      flow.go("choose-strategy");
      return;
    }
    await flow.create({ identifier: values.identifier.trim() });
  });

  const social = environment.social.length > 0 ? (
    <SocialButtons
      providers={environment.social}
      disabled={flow.busy}
      lastUsedStrategy={lastUsedStrategy}
      onSelect={(provider) => void flow.authenticateWithRedirect(provider.strategy)}
    />
  ) : null;

  return (
    <div className="flex flex-col gap-5">
      <FormError message={flow.error} />
      {social && socialAtTop ? (
        <>
          {social}
          {hasIdentifiers || passkeyEnabled ? <Divider /> : null}
        </>
      ) : null}
      {hasIdentifiers ? (
        <form onSubmit={submit} {...ep("form", "flex flex-col gap-4")} noValidate>
          <Field
            control={form.control}
            name="identifier"
            label={identifierLabel(t, environment.identifiers)}
            required
            labelAccessory={identifierLastUsed ? <LastUsedBadge testId="identifier-last-used" /> : undefined}
          >
            {(field) => (
              <Input
                {...field}
                type={identifierInputType(environment.identifiers)}
                autoComplete={`${identifierAutoComplete(environment.identifiers)}${passkeyEnabled && environment.passkey.allowAutofill ? " webauthn" : ""}`}
                placeholder={t("signIn.start.identifierPlaceholder")}
                autoFocus
                disabled={flow.busy}
                {...ep("formFieldInput")}
              />
            )}
          </Field>
          <Button type="submit" disabled={flow.busy} {...ep("formButtonPrimary", "w-full")}>
            {flow.busy ? <Loader2Icon className="size-4 animate-spin" aria-hidden="true" /> : null}
            {t("signIn.start.actionText")}
          </Button>
        </form>
      ) : null}
      {passkeyEnabled && environment.passkey.showSignInButton ? (
        <Button
          type="button"
          variant="outline"
          className={cn("relative w-full gap-2", passkeyLastUsed && "px-[4.75rem] has-[>svg]:px-[4.75rem]")}
          disabled={flow.busy}
          aria-label={passkeyLastUsed ? `${t("signIn.passkey.button")}, ${t("signIn.lastUsed")}` : undefined}
          onClick={() => void flow.authenticateWithPasskey()}
        >
          <FingerprintIcon className="size-4" aria-hidden="true" />
          {t("signIn.passkey.button")}
          {passkeyLastUsed ? (
            <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center">
              <LastUsedBadge testId="passkey-last-used" />
            </span>
          ) : null}
        </Button>
      ) : null}
      {social && !socialAtTop ? (
        <>
          {hasIdentifiers || passkeyEnabled ? <Divider /> : null}
          {social}
        </>
      ) : null}
      {hasIdentifiers || canResetPassword ? (
        <div className="flex flex-col items-center gap-2">
          {hasIdentifiers ? (
            <LinkButton label={t("signIn.start.useAnotherMethod")} onClick={() => flow.go("choose-strategy")} />
          ) : null}
          {canResetPassword ? (
            <LinkButton label={t("signIn.start.forgotPassword")} onClick={() => flow.go("forgot-password")} />
          ) : null}
        </div>
      ) : null}
      {(props.withSignUp ?? true) && environment.signUp.mode !== "restricted" ? (
        <FooterSwitch
          text={t("signIn.start.noAccount")}
          actionLabel={t("signIn.start.signUpAction")}
          onClick={() =>
            navigate(
              signUpUrlFor(
                props,
                undefined,
                typeof orbit.buildSignUpUrl === "function" ? orbit.buildSignUpUrl() : undefined,
              ),
            )
          }
        />
      ) : null}
    </div>
  );
}
