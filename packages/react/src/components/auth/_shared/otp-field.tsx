import { useId } from "react";
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot, Label } from "@orbitid/ui";
import { useComponentElements } from "./appearance";
import { useAuthRuntime } from "./w6";

export interface OtpFieldProps {
  value: string;
  onChange: (value: string) => void;
  onComplete?: (value: string) => void;
  length?: number;
  label?: string;
  error?: string | null;
  disabled?: boolean;
  autoFocus?: boolean;
  id?: string;
  name?: string;
  className?: string;
  /** Render a separator between the first and second half of the code. */
  grouped?: boolean;
}

/** Six-digit verification code input built on the shadcn `InputOTP` primitive. */
export function OtpField({
  value,
  onChange,
  onComplete,
  length = 6,
  label,
  error,
  disabled,
  autoFocus,
  id,
  name,
  className,
  grouped = true,
}: OtpFieldProps) {
  const { t } = useAuthRuntime();
  const { ep } = useComponentElements();
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const errorId = `${inputId}-error`;

  const handleChange = (next: string) => {
    onChange(next);
    if (next.length === length) onComplete?.(next);
  };

  const slots = Array.from({ length }, (_, index) => index);
  const splitIndex = Math.ceil(length / 2);
  const firstHalf = slots.slice(0, splitIndex);
  const secondHalf = slots.slice(splitIndex);

  return (
    <div {...ep(["formField", "otpCodeField"], "flex flex-col gap-2", className)}>
      {label ? (
        <Label htmlFor={inputId} {...ep("formFieldLabel", "text-sm font-medium")}>
          {label}
        </Label>
      ) : null}
      <InputOTP
        id={inputId}
        name={name}
        value={value}
        onChange={handleChange}
        maxLength={length}
        pattern="^[0-9]*$"
        disabled={disabled}
        autoFocus={autoFocus}
        inputMode="numeric"
        autoComplete="one-time-code"
        aria-label={label ?? t("formFieldLabel__code")}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        containerClassName={ep("formFieldInputGroup", "justify-center").className}
      >
        <InputOTPGroup>
          {firstHalf.map((index) => (
            <InputOTPSlot
              key={index}
              index={index}
              {...ep("otpCodeFieldInput", "size-10 text-base")}
            />
          ))}
        </InputOTPGroup>
        {grouped && secondHalf.length > 0 ? <InputOTPSeparator /> : null}
        {secondHalf.length > 0 ? (
          <InputOTPGroup>
            {secondHalf.map((index) => (
              <InputOTPSlot
                key={index}
                index={index}
                {...ep("otpCodeFieldInput", "size-10 text-base")}
              />
            ))}
          </InputOTPGroup>
        ) : null}
      </InputOTP>
      {error ? (
        <p id={errorId} role="alert" {...ep("formFieldErrorText", "text-center text-xs text-destructive")}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
