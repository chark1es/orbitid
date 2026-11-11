import { useId, useState, type KeyboardEvent, type ClipboardEvent } from "react";
import { Badge, Button, Input, Label, cn } from "@orbitid/ui";
import { XIcon } from "lucide-react";
import { useLocalizations } from "../../../localization";
import { dedupeEmails, isValidEmail, splitEmails } from "./utils";

export interface EmailChipsInputProps {
  value: string[];
  onChange: (emails: string[]) => void;
  id?: string;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  /** External (server) error, shown under the field. */
  error?: string | null;
  /** Accessible name when no visible `label` is rendered. */
  ariaLabel?: string;
  className?: string;
  autoFocus?: boolean;
}

/**
 * Multi-email input with chips: Enter/comma adds, paste splits, Backspace removes the last chip,
 * duplicates are ignored and invalid addresses keep the draft for editing.
 */
export function EmailChipsInput({
  value,
  onChange,
  id,
  label,
  placeholder,
  disabled,
  error,
  ariaLabel,
  className,
  autoFocus,
}: EmailChipsInputProps) {
  const { t } = useLocalizations();
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const [draft, setDraft] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const add = (candidates: string[]) => {
    const next = dedupeEmails([...value, ...candidates]);
    if (next.length === value.length) {
      if (candidates.length > 0) setLocalError(t("formFieldError__duplicateEmail"));
      return false;
    }
    onChange(next);
    setLocalError(null);
    return true;
  };

  const commitDraft = () => {
    const candidates = splitEmails(draft);
    if (candidates.length === 0) return true;
    if (candidates.some((email) => !isValidEmail(email))) {
      setLocalError(t("formFieldError__invalidEmail"));
      return false;
    }
    const added = add(candidates);
    if (added) setDraft("");
    return added;
  };

  const remove = (email: string) => {
    onChange(value.filter((item) => item.toLowerCase() !== email.toLowerCase()));
    setLocalError(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === "," || event.key === ";") {
      event.preventDefault();
      commitDraft();
      return;
    }
    if (event.key === "Backspace" && draft === "" && value.length > 0) {
      event.preventDefault();
      remove(value[value.length - 1]!);
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text");
    if (!/[\s,;]/.test(text.trim())) return;
    event.preventDefault();
    const candidates = splitEmails(text);
    if (candidates.some((email) => !isValidEmail(email))) {
      setLocalError(t("formFieldError__invalidEmail"));
      setDraft((previous) => `${previous}${text}`);
      return;
    }
    if (add(candidates)) setDraft("");
  };

  const message = error ?? localError;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label ? <Label htmlFor={inputId}>{label}</Label> : null}
      <div
        className={cn(
          "flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-input bg-transparent px-2 py-1.5 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30",
          disabled && "opacity-50",
        )}
        data-testid="email-chips"
      >
        {value.map((email) => (
          <Badge key={email.toLowerCase()} variant="secondary" className="gap-1 py-0.5 pl-2 pr-0.5">
            <span className="max-w-[16rem] truncate">{email}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={disabled}
              aria-label={t("formFieldLabel__removeEmail", { identifier: email })}
              className="rounded-full"
              onClick={() => remove(email)}
            >
              <XIcon aria-hidden="true" />
            </Button>
          </Badge>
        ))}
        <Input
          id={inputId}
          type="email"
          inputMode="email"
          autoComplete="off"
          autoFocus={autoFocus}
          aria-label={ariaLabel ?? label ?? t("formFieldLabel__emailAddresses")}
          aria-invalid={message ? true : undefined}
          disabled={disabled}
          value={draft}
          placeholder={value.length === 0 ? placeholder : undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            if (localError) setLocalError(null);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => {
            if (draft.trim()) commitDraft();
          }}
          className="h-7 min-w-[10rem] flex-1 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
      </div>
      {message ? (
        <p className="text-sm text-destructive" role="alert">
          {message}
        </p>
      ) : null}
    </div>
  );
}
