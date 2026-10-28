import { useId, useState } from "react";
import { CheckIcon, EyeIcon, EyeOffIcon, XIcon } from "lucide-react";
import { Button, Input, Label, Progress, cn } from "@orbitid/ui";
import type { PasswordSettingsView } from "./environment";
import { useElementClasses } from "./appearance";
import { useAuthRuntime, type TranslateFn } from "./w6";

export const DEFAULT_PASSWORD_SETTINGS: PasswordSettingsView = {
  minLength: 8,
  maxLength: 72,
  requireLowercase: false,
  requireUppercase: false,
  requireNumbers: false,
  requireSpecialChar: false,
};

export type PasswordRequirementId = "length" | "lowercase" | "uppercase" | "numbers" | "special";

export interface PasswordRequirement {
  id: PasswordRequirementId;
  met: boolean;
}

export function passwordRequirements(
  password: string,
  settings: PasswordSettingsView = DEFAULT_PASSWORD_SETTINGS,
): PasswordRequirement[] {
  const requirements: PasswordRequirement[] = [
    { id: "length", met: password.length >= settings.minLength && password.length <= settings.maxLength },
  ];
  if (settings.requireLowercase) requirements.push({ id: "lowercase", met: /[a-z]/.test(password) });
  if (settings.requireUppercase) requirements.push({ id: "uppercase", met: /[A-Z]/.test(password) });
  if (settings.requireNumbers) requirements.push({ id: "numbers", met: /\d/.test(password) });
  if (settings.requireSpecialChar) requirements.push({ id: "special", met: /[^A-Za-z0-9]/.test(password) });
  return requirements;
}

export function passwordScore(
  password: string,
  settings: PasswordSettingsView = DEFAULT_PASSWORD_SETTINGS,
): number {
  const requirements = passwordRequirements(password, settings);
  const met = requirements.filter((requirement) => requirement.met).length;
  if (password.length === 0) return 0;
  const bonus = password.length >= settings.minLength + 4 ? 1 : 0;
  return Math.max(0, Math.min(4, Math.round((met / requirements.length) * 3) + bonus));
}

export function passwordMeetsPolicy(
  password: string,
  settings: PasswordSettingsView = DEFAULT_PASSWORD_SETTINGS,
): boolean {
  return passwordRequirements(password, settings).every((requirement) => requirement.met);
}

const STRENGTH_KEYS = [
  "signUp.passwordStrength.weak",
  "signUp.passwordStrength.weak",
  "signUp.passwordStrength.fair",
  "signUp.passwordStrength.good",
  "signUp.passwordStrength.strong",
] as const;

export interface PasswordInputProps {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  autoComplete?: string;
  id?: string;
  name?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
  className?: string;
}

/** Password input with an accessible show/hide toggle. */
export function PasswordInput({
  value,
  onChange,
  onBlur,
  placeholder,
  autoComplete = "current-password",
  id,
  name,
  disabled,
  autoFocus,
  className,
  ...aria
}: PasswordInputProps) {
  const { t } = useAuthRuntime();
  const { el } = useElementClasses();
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input
        id={inputId}
        name={name}
        type={visible ? "text" : "password"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        placeholder={placeholder}
        autoComplete={autoComplete}
        disabled={disabled}
        autoFocus={autoFocus}
        aria-invalid={aria["aria-invalid"]}
        aria-describedby={aria["aria-describedby"]}
        className={cn("pe-10", el("formFieldInput"), className)}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        tabIndex={-1}
        disabled={disabled}
        onClick={() => setVisible((current) => !current)}
        aria-label={visible ? t("common.hidePassword") : t("common.showPassword")}
        aria-pressed={visible}
        className="absolute end-1 top-1/2 size-8 -translate-y-1/2 text-muted-foreground hover:text-foreground"
      >
        {visible ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
      </Button>
    </div>
  );
}

export interface PasswordFieldProps extends Omit<PasswordInputProps, "id" | "name"> {
  label?: string;
  description?: string;
  error?: string | null;
  required?: boolean;
  showStrength?: boolean;
  settings?: PasswordSettingsView;
  showRequirements?: boolean;
}

/** Label + password input + optional live policy checklist and strength meter. */
export function PasswordField({
  label,
  description,
  error,
  required,
  showStrength = false,
  showRequirements = false,
  settings = DEFAULT_PASSWORD_SETTINGS,
  value,
  className,
  ...inputProps
}: PasswordFieldProps) {
  const { t } = useAuthRuntime();
  const { el } = useElementClasses();
  const generatedId = useId();
  const inputId = generatedId;
  const hintId = `${inputId}-hint`;
  const requirements = passwordRequirements(value, settings);
  const score = passwordScore(value, settings);

  return (
    <div className={cn("flex flex-col gap-1.5", el("formField"), className)}>
      {label ? (
        <Label htmlFor={inputId} className={cn("text-sm font-medium", el("formFieldLabel"))}>
          {label}
          {required ? (
            <span aria-hidden="true" className="text-destructive">
              *
            </span>
          ) : null}
        </Label>
      ) : null}
      <PasswordInput
        {...inputProps}
        id={inputId}
        value={value}
        aria-invalid={Boolean(error)}
        aria-describedby={hintId}
        className={el("formFieldInput")}
      />
      {showStrength && value.length > 0 ? (
        <div className="flex items-center gap-2" data-testid="password-strength">
          <Progress value={score * 25} className="h-1.5 flex-1" aria-hidden="true" />
          <span className="w-12 text-end text-xs text-muted-foreground">{t(STRENGTH_KEYS[score] ?? STRENGTH_KEYS[0])}</span>
        </div>
      ) : null}
      {showRequirements ? (
        <ul id={hintId} className="flex flex-col gap-1 text-xs text-muted-foreground" aria-live="polite">
          {requirements.map((requirement) => (
            <li key={requirement.id} className="flex items-center gap-1.5">
              {requirement.met ? (
                <CheckIcon className="size-3 text-go" aria-hidden="true" />
              ) : (
                <XIcon className="size-3 text-muted-foreground" aria-hidden="true" />
              )}
              <span className={cn(requirement.met && "text-foreground")}>
                {requirementLabel(t, requirement.id, settings)}
              </span>
            </li>
          ))}
        </ul>
      ) : description ? (
        <p id={hintId} className={cn("text-xs text-muted-foreground", el("formFieldHintText"))}>
          {description}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className={cn("text-xs text-destructive", el("formFieldErrorText"))}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

function requirementLabel(
  t: TranslateFn,
  id: PasswordRequirementId,
  settings: PasswordSettingsView,
): string {
  switch (id) {
    case "length":
      return t("signUp.start.passwordHintLength", { min: settings.minLength });
    case "lowercase":
      return t("signUp.start.passwordHintLowercase");
    case "uppercase":
      return t("signUp.start.passwordHintUppercase");
    case "numbers":
      return t("signUp.start.passwordHintNumbers");
    case "special":
      return t("signUp.start.passwordHintSpecial");
  }
}
