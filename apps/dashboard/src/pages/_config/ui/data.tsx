import * as React from "react";
import { Button, Input, Table, Textarea, cn } from "@orbitid/ui";
import { Plus, X } from "lucide-react";
import { CopyButton } from "./clipboard";

/** Table frame with the shared row height, rule, and column header treatment. */
export function RuledTable({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("w-full border-y border-border", className)}>
      <Table
        className={cn(
          "[&_thead_tr]:border-border [&_thead_tr:hover]:bg-transparent",
          "[&_th]:h-9 [&_th]:text-[0.75rem] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-[0.04em] [&_th]:text-muted-foreground",
          "[&_td]:h-10 [&_td]:py-0 [&_tbody_tr]:border-border [&_tbody_tr:hover]:bg-muted/40",
        )}
      >
        {children}
      </Table>
    </div>
  );
}

export interface JsonEditorProps extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> {
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
}

export const JsonEditor = React.forwardRef<HTMLTextAreaElement, JsonEditorProps>(function JsonEditor(
  { value, onChange, error, className, rows = 12, ...props },
  ref,
) {
  return (
    <div className="space-y-1.5">
      <Textarea
        ref={ref}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        rows={rows}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={cn("min-h-40 font-data text-xs leading-relaxed", error && "border-destructive", className)}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${props.id ?? "json"}-error` : undefined}
        {...props}
      />
      {error ? (
        <p id={`${props.id ?? "json"}-error`} className="text-xs font-medium text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
});

export function StringListEditor({
  values,
  onChange,
  placeholder = "https://example.com",
  addLabel = "Add item",
  emptyLabel = "No items yet.",
  inputType = "url",
}: {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  addLabel?: string;
  emptyLabel?: string;
  inputType?: React.HTMLInputTypeAttribute;
}) {
  const update = (index: number, value: string) => {
    const next = [...values];
    next[index] = value;
    onChange(next);
  };
  return (
    <div className="space-y-2">
      {values.length === 0 ? <p className="text-xs text-muted-foreground">{emptyLabel}</p> : null}
      {values.map((value, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            type={inputType}
            value={value}
            placeholder={placeholder}
            onChange={(event) => update(index, event.target.value)}
            className="font-data text-xs"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => onChange(values.filter((_, itemIndex) => itemIndex !== index))}
            title="Remove"
          >
            <X className="size-4" aria-hidden />
            <span className="sr-only">Remove</span>
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={() => onChange([...values, ""])}>
        <Plus className="size-4" aria-hidden />
        {addLabel}
      </Button>
    </div>
  );
}

export function EndpointRow({ label, description, url }: { label: string; description?: string; url: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border py-2 last:border-b-0">
      <div className="min-w-0 space-y-0.5">
        <p className="text-[0.8125rem] font-medium">{label}</p>
        <code className="block truncate font-data text-xs text-muted-foreground">{url}</code>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <CopyButton value={url} size="icon-sm" variant="outline" />
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  const positive = ["active", "success", "enabled", "verified", "accepted", "complete", "delivered"].includes(normalized);
  const caution = ["pending", "expired", "disabled", "inactive", "paused"].includes(normalized);
  const negative = ["failed", "revoked", "rejected", "banned", "locked"].includes(normalized);
  return (
    <span className="inline-flex w-fit items-center gap-1.5 rounded-sm border border-border px-1.5 py-0.5 text-xs font-medium capitalize">
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          positive ? "bg-go" : negative ? "bg-signal" : caution ? "bg-caution" : "bg-muted-foreground",
        )}
        aria-hidden
      />
      {normalized.replace(/_/g, " ")}
    </span>
  );
}
