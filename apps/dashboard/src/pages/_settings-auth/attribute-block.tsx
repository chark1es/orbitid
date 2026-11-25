import type { AttributeConfig } from "@orbitid/shared";
import { Switch } from "@orbitid/ui";
import { CheckboxRow } from "../_config/ui";

export function AttributeBlock({
  title,
  description,
  config,
  onChange,
  verificationOptions,
  showVerification = true,
  showVerifyAtSignUp = true,
  problems = [],
}: {
  title: string;
  description: string;
  config: AttributeConfig;
  onChange: (patch: Partial<AttributeConfig>) => void;
  verificationOptions?: { value: string; label: string }[];
  showVerification?: boolean;
  showVerifyAtSignUp?: boolean;
  /** Settings that cannot be saved as they stand. Shown beside the control that causes them. */
  problems?: string[];
}) {
  const disabled = !config.enabled;
  return (
    <div className="space-y-3 border-b border-border pb-5 last:border-b-0 last:pb-0">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium">{title}</p>
          <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">{description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          <span className="text-xs text-muted-foreground">{config.enabled ? "On" : "Off"}</span>
          <Switch
            checked={config.enabled}
            // Turning an attribute off also makes it optional, so a hidden "required" cannot block sign-up.
            onCheckedChange={(enabled) => onChange(enabled ? { enabled } : { enabled, required: false })}
            aria-label={`Enable ${title}`}
          />
        </div>
      </div>
      {problems.length > 0 ? (
        <ul role="alert" className="space-y-1 text-[0.8125rem] leading-relaxed text-signal">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}
      <div className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
        <CheckboxRow
          label="Required"
          description="Users must supply this attribute at sign-up."
          checked={config.required}
          disabled={disabled}
          onCheckedChange={(required) => onChange({ required })}
        />
        <CheckboxRow
          label="Used for sign-in"
          description="The sign-in form accepts this identifier."
          checked={config.usedForFirstFactor}
          disabled={disabled}
          onCheckedChange={(usedForFirstFactor) => onChange({ usedForFirstFactor })}
        />
        {showVerifyAtSignUp ? (
          <CheckboxRow
            label="Verify at sign-up"
            description="Sign-up completes only after verification."
            checked={config.verifyAtSignUp}
            disabled={disabled}
            onCheckedChange={(verifyAtSignUp) => onChange({ verifyAtSignUp })}
          />
        ) : null}
      </div>
      {showVerification && verificationOptions?.length ? (
        <fieldset className="space-y-1 border-t border-border pt-3">
          <legend className="text-xs font-medium text-muted-foreground">Verification methods</legend>
          <div className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
            {verificationOptions.map((option) => (
              <CheckboxRow
                key={option.value}
                label={option.label}
                checked={config.verifications.includes(option.value)}
                disabled={disabled}
                onCheckedChange={(checked) =>
                  onChange({
                    verifications: checked
                      ? [...config.verifications, option.value]
                      : config.verifications.filter((value) => value !== option.value),
                  })
                }
              />
            ))}
          </div>
          {config.verifications.length === 0 ? (
            <p className="text-xs text-muted-foreground">No method selected. Users cannot verify this attribute, so sign-up will block when verification is required.</p>
          ) : null}
        </fieldset>
      ) : null}
    </div>
  );
}
