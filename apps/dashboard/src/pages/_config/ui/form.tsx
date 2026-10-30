import * as React from "react";
import { associateFieldControl, firstControlId } from "./field-control";
import { Button, Checkbox, Input, Label, Switch, cn } from "@orbitid/ui";
import { AlertCircle, Check, Loader2 } from "lucide-react";

export function Field({
  label,
  description,
  error,
  htmlFor,
  required,
  children,
  className,
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  error?: string | null;
  htmlFor?: string;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  const generatedId = React.useId();
  const id = htmlFor ?? firstControlId(children) ?? `field-${generatedId}`;
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={id} className="text-[0.8125rem] font-medium">
        {label}
        {required ? (
          <span className="ml-0.5 text-destructive" aria-hidden>
            *
          </span>
        ) : null}
      </Label>
      {associateFieldControl(children, { id, describedBy, invalid: Boolean(error), required })}
      {description ? <p id={descriptionId} className="text-xs leading-relaxed text-muted-foreground">{description}</p> : null}
      {error ? <p id={errorId} role="alert" className="text-xs font-medium text-destructive">{error}</p> : null}
    </div>
  );
}

/**
 * Write-only secret field. The server masks a stored secret (`••••`) and marks it with `<field>Set`, so the
 * input starts blank: typing a value replaces the stored one, leaving it blank keeps it.
 */
export function SecretInput({
  id,
  label,
  value,
  onChange,
  configured,
  description,
  placeholder,
  disabled,
  required,
  className,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  configured: boolean;
  description?: React.ReactNode;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  className?: string;
}) {
  return (
    <Field
      label={label}
      htmlFor={id}
      description={
        <span className="flex flex-wrap items-center gap-1.5">
          <SecretSetChip configured={configured} />
          <span>{description ?? (configured ? "A value is stored. Leave blank to keep it." : "No value is stored yet.")}</span>
        </span>
      }
      required={required}
      className={className}
    >
      <Input
        id={id}
        type="password"
        autoComplete="new-password"
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder ?? (configured ? "Stored value, leave blank to keep" : "Not set")}
      />
    </Field>
  );
}

/** A word plus a dot, so the state does not rely on colour. */
export function SecretSetChip({ configured }: { configured: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-sm border border-border px-1.5 py-0.5 text-[0.6875rem] font-medium text-muted-foreground">
      <span className={cn("size-1.5 rounded-full", configured ? "bg-go" : "bg-muted-foreground")} aria-hidden />
      {configured ? "Set" : "Not set"}
    </span>
  );
}


export function SwitchRow({
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
  id,
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
}) {
  const generatedId = React.useId();
  const controlId = id ?? generatedId;
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-6 border-b border-border py-3 first:pt-0 last:border-b-0 last:pb-0",
      )}
    >
      <div className="min-w-0 space-y-0.5">
        <Label htmlFor={controlId} className="text-sm font-medium">
          {label}
        </Label>
        {description ? <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">{description}</p> : null}
      </div>
      <Switch id={controlId} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} className="mt-0.5" />
    </div>
  );
}

export function CheckboxRow({
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 py-1.5",
        disabled && "cursor-not-allowed",
      )}
    >
      <Checkbox
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      />
      <span className="space-y-0.5">
        <span className="block text-sm font-medium leading-5">{label}</span>
        {description ? <span className="block text-[0.8125rem] leading-relaxed text-muted-foreground">{description}</span> : null}
      </span>
    </label>
  );
}

export function ValidationSummary({
  errors,
  title = "Cannot save yet",
}: {
  errors: readonly string[];
  title?: string;
}) {
  if (errors.length === 0) return null;
  return (
    <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2.5">
      <p className="text-xs font-semibold text-destructive">{title}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs leading-relaxed text-muted-foreground">
        {errors.map((error) => (
          <li key={error}>{error}</li>
        ))}
      </ul>
      <p className="mt-1.5 text-xs text-muted-foreground">Fix the listed fields, then save again.</p>
    </div>
  );
}

export function SaveBar({
  dirty,
  saving,
  disabled,
  errors = [],
  error,
  onSave,
  onDiscard,
  saveLabel = "Save changes",
}: {
  dirty: boolean;
  saving: boolean;
  disabled?: boolean;
  errors?: readonly string[];
  error?: string | null;
  onSave: () => void | Promise<boolean | void>;
  onDiscard: () => void;
  saveLabel?: string;
}) {
  if (!dirty && !saving && errors.length === 0) return null;
  return (
    <div
      // Arrives from below the fold it sits on, so the new "unsaved" state is noticed without a shout.
      className="sticky bottom-0 z-20 -mx-4 mt-8 animate-in fade-in-0 slide-in-from-bottom-2 border-t border-border bg-background px-4 py-3 duration-200 ease-out md:-mx-6 md:px-6"
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-1" role={errors.length > 0 ? "alert" : undefined}>
          {errors.length > 0 ? (
            <>
              <p className="flex items-center gap-2 text-sm font-medium text-destructive">
                <AlertCircle className="size-4" aria-hidden />
                {errors.length === 1 ? "One setting needs attention" : `${errors.length} settings need attention`}
              </p>
              <ul className="list-disc space-y-0.5 pl-6 text-xs leading-relaxed text-muted-foreground">
                {errors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
              <p className="pl-6 text-xs text-muted-foreground">Fix the listed fields to enable saving.</p>
            </>
          ) : (
            <p className="flex items-center gap-2 text-sm">
              <span className="size-1.5 rounded-full bg-caution" aria-hidden />
              <span className="font-medium">Unsaved changes</span>
              <span className="text-muted-foreground">Save to apply them to this instance.</span>
            </p>
          )}
          {error ? (
            <p role="alert" className="max-w-[70ch] text-xs leading-relaxed text-destructive">
              Save failed: {error} Check the server log, then save again.
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2 lg:pt-0.5">
          <Button variant="outline" size="sm" onClick={onDiscard} disabled={saving || !dirty}>
            Discard
          </Button>
          <Button size="sm" onClick={() => void onSave()} disabled={saving || disabled || !dirty}>
            {saving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Check className="size-4" aria-hidden />}
            {saving ? "Saving…" : saveLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
