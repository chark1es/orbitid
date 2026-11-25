import { useId, type ReactNode } from "react";
import { Controller, type Control, type ControllerRenderProps, type FieldPath, type FieldValues } from "react-hook-form";
import { Label, cn } from "@orbitid/ui";
import { useComponentElements } from "./appearance";

export interface FieldProps<TFieldValues extends FieldValues> {
  control: Control<TFieldValues>;
  name: FieldPath<TFieldValues>;
  label: string;
  description?: string;
  required?: boolean;
  /** Shown at the end of the label row, e.g. a "Last used" badge. */
  labelAccessory?: ReactNode;
  className?: string;
  children: (
    field: ControllerRenderProps<TFieldValues, FieldPath<TFieldValues>> & {
      id: string;
      "aria-invalid"?: boolean;
      "aria-describedby"?: string;
    },
  ) => ReactNode;
}

/** react-hook-form + shadcn Form wrapper with label, description, and validation message. */
export function Field<TFieldValues extends FieldValues>({
  control,
  name,
  label,
  description,
  required,
  labelAccessory,
  className,
  children,
}: FieldProps<TFieldValues>) {
  const { ep } = useComponentElements();
  const generatedId = useId();
  const inputId = `${generatedId}-${String(name)}`;
  const descriptionId = `${inputId}-description`;
  const errorId = `${inputId}-error`;
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => {
        const hasError = Boolean(fieldState.error?.message);
        const describedBy = [description ? descriptionId : null, hasError ? errorId : null].filter(Boolean).join(" ");
        const labelElement = (
          <Label htmlFor={inputId} {...ep("formFieldLabel", "text-sm font-medium")}>
            {label}
            {required ? (
              <span aria-hidden="true" className="text-destructive">
                *
              </span>
            ) : null}
          </Label>
        );
        return (
          <div {...ep("formField", "grid gap-1.5", className)}>
            {labelAccessory ? (
              <div className="flex items-center justify-between gap-2">
                {labelElement}
                {labelAccessory}
              </div>
            ) : (
              labelElement
            )}
            {children({
              ...field,
              id: inputId,
              "aria-invalid": hasError ? true : undefined,
              "aria-describedby": describedBy || undefined,
            })}
            {description ? (
              <p id={descriptionId} {...ep("formFieldHintText", "text-xs text-muted-foreground")}>
                {description}
              </p>
            ) : null}
            {hasError ? (
              <p id={errorId} role="alert" {...ep("formFieldErrorText", "text-xs text-destructive")}>
                {fieldState.error?.message}
              </p>
            ) : null}
          </div>
        );
      }}
    />
  );
}
