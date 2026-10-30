import { useState, type ReactNode } from "react";
import { Button, Input, Label } from "@orbitid/ui";
import {
  ArrowLeftIcon,
  Building2Icon,
  FingerprintIcon,
  KeyRoundIcon,
  LinkIcon,
  MailIcon,
  SmartphoneIcon,
} from "lucide-react";
import { factorsOf } from "../../_shared/api";
import { signUpUrlFor } from "../flow";
import { useAuthRuntime, type TranslateFn } from "../../_shared/w6";
import { FormError } from "../../_shared/form-error";
import { ProviderIcon } from "../../_shared/provider-icon";
import type { EnvironmentView } from "../../_shared/environment";
import { LinkButton, identifierAutoComplete, identifierInputType, identifierLabel, type StepProps } from "./shared";

export function ChooseStrategyStep({ flow, props }: StepProps) {
  const runtime = useAuthRuntime();
  const { t, environment, navigate, orbit } = runtime;
  const [identifier, setIdentifier] = useState(flow.identifierDraft);
  const factors = factorsOf(flow.signIn, "first");

  const options = buildStrategyOptions(factors, environment, t);
  // The identifier is what selects the account. An instance that signs in only through social connections or
  // passkeys has no identifier to ask for, and those methods already sit on the first screen.
  const needsIdentifier = !flow.signIn && environment.identifiers.length > 0;

  const choose = async (strategy: string) => {
    let current = flow.signIn;
    if (!current) {
      if (!needsIdentifier) {
        flow.go("start");
        return;
      }
      const trimmed = identifier.trim();
      if (!trimmed) {
        flow.setError(t("formFieldError__required"));
        return;
      }
      flow.setIdentifierDraft(trimmed);
      current = await flow.create({ identifier: trimmed }, { route: false });
      if (!current) return;
    }
    const factor = factorsOf(current, "first").find((candidate) => candidate.strategy === strategy);
    await flow.selectFirstFactor(factor ?? { strategy });
  };

  return (
    <div className="flex flex-col gap-4">
      <FormError message={flow.error} />
      <p className="text-sm text-muted-foreground">{t("signIn.chooseStrategy.subtitle")}</p>
      {needsIdentifier ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="choose-identifier" className="text-sm font-medium">
            {identifierLabel(t, environment.identifiers)}
          </Label>
          <Input
            id="choose-identifier"
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
            type={identifierInputType(environment.identifiers)}
            autoComplete={identifierAutoComplete(environment.identifiers)}
            placeholder={t("signIn.start.identifierPlaceholder")}
            disabled={flow.busy}
          />
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        {options.map((option) => (
          <Button
            key={option.strategy}
            type="button"
            variant="outline"
            className="w-full justify-start gap-2"
            disabled={flow.busy}
            data-testid={`strategy-${option.strategy}`}
            onClick={() => void choose(option.strategy)}
          >
            {option.icon}
            <span className="truncate">{option.label}</span>
            {option.description ? (
              <span className="ms-auto truncate text-xs text-muted-foreground">{option.description}</span>
            ) : null}
          </Button>
        ))}
      </div>
      <div className="flex items-center justify-between">
        <Button type="button" variant="ghost" size="sm" className="gap-1.5" onClick={() => flow.go("start")}>
          <ArrowLeftIcon className="size-4" aria-hidden="true" />
          {t("common.back")}
        </Button>
        {(props.withSignUp ?? true) && environment.signUp.mode !== "restricted" ? (
          <LinkButton
            label={t("signIn.start.signUpAction")}
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
    </div>
  );
}

interface StrategyOption {
  strategy: string;
  label: string;
  description?: string;
  icon: ReactNode;
}

function buildStrategyOptions(
  factors: ReturnType<typeof factorsOf>,
  environment: EnvironmentView,
  t: TranslateFn,
): StrategyOption[] {
  const options: StrategyOption[] = [];
  const seen = new Set<string>();
  const factorsWithIcons = factors.length > 0 ? factors : inferFactors(environment);
  for (const factor of factorsWithIcons) {
    if (seen.has(factor.strategy)) continue;
    seen.add(factor.strategy);
    const safeIdentifier = factor.safe_identifier;
    if (factor.strategy === "password") {
      options.push({ strategy: factor.strategy, label: t("signIn.chooseStrategy.password"), icon: <KeyRoundIcon className="size-4" /> });
    } else if (factor.strategy === "email_code") {
      options.push({
        strategy: factor.strategy,
        label: t("signIn.chooseStrategy.emailCode"),
        description: safeIdentifier,
        icon: <MailIcon className="size-4" />,
      });
    } else if (factor.strategy === "email_link") {
      options.push({
        strategy: factor.strategy,
        label: t("signIn.chooseStrategy.emailLink"),
        description: safeIdentifier,
        icon: <LinkIcon className="size-4" />,
      });
    } else if (factor.strategy === "phone_code") {
      options.push({
        strategy: factor.strategy,
        label: t("signIn.chooseStrategy.phoneCode"),
        description: safeIdentifier,
        icon: <SmartphoneIcon className="size-4" />,
      });
    } else if (factor.strategy === "passkey") {
      options.push({ strategy: factor.strategy, label: t("signIn.chooseStrategy.passkey"), icon: <FingerprintIcon className="size-4" /> });
    } else if (factor.strategy === "enterprise_sso" || factor.strategy === "saml") {
      options.push({
        strategy: factor.strategy,
        label: t("signIn.chooseStrategy.enterpriseSso"),
        icon: <Building2Icon className="size-4" />,
      });
    } else if (factor.strategy === "reset_password_email_code") {
      options.push({
        strategy: factor.strategy,
        label: t("signIn.chooseStrategy.resetPassword"),
        description: safeIdentifier,
        icon: <KeyRoundIcon className="size-4" />,
      });
    } else if (factor.strategy.startsWith("oauth_")) {
      const providerId = factor.strategy.replace(/^oauth_/, "");
      const provider = environment.social.find((candidate) => candidate.id === providerId || candidate.strategy === factor.strategy);
      options.push({
        strategy: factor.strategy,
        label: t("signIn.chooseStrategy.oauth", { provider: provider?.name ?? providerId }),
        icon: <ProviderIcon provider={providerId} />,
      });
    }
  }
  if (options.length === 0 && environment.attributes.password.enabled) {
    options.push({
      strategy: "password",
      label: t("signIn.chooseStrategy.password"),
      icon: <KeyRoundIcon className="size-4" />,
    });
  }
  return options;
}

function inferFactors(environment: EnvironmentView) {
  const factors: Array<{ strategy: string; safe_identifier?: string }> = [];
  const { email_address: email, phone_number: phone } = environment.attributes;
  if (environment.attributes.password.enabled) factors.push({ strategy: "password" });
  // Only methods that start from an identifier the sign-in form accepts.
  if (email.enabled && email.usedForFirstFactor) {
    if (email.verifications.includes("email_code")) factors.push({ strategy: "email_code" });
    if (email.verifications.includes("email_link")) factors.push({ strategy: "email_link" });
  }
  if (phone.enabled && phone.usedForFirstFactor) factors.push({ strategy: "phone_code" });
  if (environment.attributes.passkey.enabled) factors.push({ strategy: "passkey" });
  return factors;
}
