import { Button, Label, Textarea, cn } from "@orbitid/ui";
import { formatJsonText, parseJsonObject } from "../../lib/format";
import { fieldIds } from "../../lib/hooks";

export function JsonEditor({
  id,
  label,
  description,
  value,
  onChange,
  rows = 10,
  placeholder,
  disabled,
  className,
}: {
  id: string;
  label?: string;
  description?: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  const parsed = parseJsonObject(value);
  const ids = fieldIds(id);
  return (
    <div className={cn("space-y-2", className)}>
      {label ? (
        <div className="space-y-1">
          <Label htmlFor={id}>{label}</Label>
          {description ? (
            <p id={ids.description} className="text-xs text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
      ) : null}
      <Textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={rows}
        spellCheck={false}
        placeholder={placeholder ?? "{}"}
        disabled={disabled}
        aria-invalid={!parsed.ok}
        aria-describedby={parsed.ok ? ids.description : ids.error}
        className={cn("min-h-24 font-mono text-xs leading-relaxed", !parsed.ok && "border-destructive focus-visible:ring-destructive/30")}
      />
      <div className="flex items-center justify-between gap-2">
        <p
          id={ids.error}
          role={parsed.ok ? undefined : "alert"}
          className={cn("text-xs", parsed.ok ? "text-muted-foreground" : "font-medium text-destructive")}
        >
          {parsed.ok ? "Valid JSON object" : parsed.error}
        </p>
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={disabled || !parsed.ok || !value.trim()}
          onClick={() => onChange(formatJsonText(value))}
        >
          Format
        </Button>
      </div>
    </div>
  );
}
