import { useId, useMemo, useState } from "react";
import { Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, cn } from "@orbitid/ui";
import { useElementClasses, usePortalClass } from "./appearance";
import { useAuthRuntime } from "./w6";

export interface CountryOption {
  code: string;
  dial: string;
  label: string;
}

export const COUNTRIES: CountryOption[] = [
  { code: "US", dial: "+1", label: "United States" },
  { code: "GB", dial: "+44", label: "United Kingdom" },
  { code: "AU", dial: "+61", label: "Australia" },
  { code: "BR", dial: "+55", label: "Brazil" },
  { code: "DE", dial: "+49", label: "Germany" },
  { code: "FR", dial: "+33", label: "France" },
  { code: "IN", dial: "+91", label: "India" },
  { code: "IT", dial: "+39", label: "Italy" },
  { code: "JP", dial: "+81", label: "Japan" },
  { code: "MX", dial: "+52", label: "Mexico" },
  { code: "NL", dial: "+31", label: "Netherlands" },
  { code: "SG", dial: "+65", label: "Singapore" },
  { code: "ES", dial: "+34", label: "Spain" },
  { code: "ZA", dial: "+27", label: "South Africa" },
];

export interface PhoneInputProps {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  disabled?: boolean;
  autoFocus?: boolean;
  id?: string;
  name?: string;
  placeholder?: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
  className?: string;
}

function countryForValue(value: string): CountryOption {
  const match = [...COUNTRIES].sort((a, b) => b.dial.length - a.dial.length).find((country) => value.startsWith(country.dial));
  return match ?? COUNTRIES[0]!;
}

/** Country-code select + national number; emits an E.164 string (`+14155550123`). */
export function PhoneInput({
  value,
  onChange,
  onBlur,
  disabled,
  autoFocus,
  id,
  name,
  placeholder,
  className,
  ...aria
}: PhoneInputProps) {
  const portalClass = usePortalClass();
  const { t } = useAuthRuntime();
  const { el } = useElementClasses();
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const [countryCode, setCountryCode] = useState(() => countryForValue(value).code);
  const country = useMemo(
    () => COUNTRIES.find((option) => option.code === countryCode) ?? COUNTRIES[0]!,
    [countryCode],
  );
  const national = value.startsWith(country.dial) ? value.slice(country.dial.length) : value.replace(/\D/g, "");

  const emit = (dial: string, digits: string) => {
    const cleaned = digits.replace(/\D/g, "");
    onChange(cleaned.length > 0 ? `${dial}${cleaned}` : "");
  };

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Select
        value={country.code}
        onValueChange={(next) => {
          setCountryCode(next);
          const option = COUNTRIES.find((candidate) => candidate.code === next);
          if (option) emit(option.dial, national);
        }}
        disabled={disabled}
      >
        <SelectTrigger className={cn("w-[7.25rem] shrink-0", el("formFieldInput"))} aria-label={t("common.phoneNumber")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent className={portalClass()}>
          {COUNTRIES.map((option) => (
            <SelectItem key={option.code} value={option.code}>
              {option.code} {option.dial}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        id={inputId}
        name={name}
        type="tel"
        inputMode="tel"
        autoComplete="tel-national"
        value={national}
        placeholder={placeholder ?? "555 555 5555"}
        disabled={disabled}
        autoFocus={autoFocus}
        onBlur={onBlur}
        onChange={(event) => emit(country.dial, event.target.value)}
        aria-invalid={aria["aria-invalid"]}
        aria-describedby={aria["aria-describedby"]}
        className={cn("flex-1", el("formFieldInput"))}
      />
    </div>
  );
}
