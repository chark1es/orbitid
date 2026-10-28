import * as React from "react";
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  Skeleton,
  Switch,
  Table,
  Textarea,
  cn,
} from "@orbitid/ui";
import { AlertCircle, Check, Copy, Eye, EyeOff, Inbox, Loader2, Plus, X } from "lucide-react";
import { toast } from "sonner";

export function PageHeader({
  title,
  description,
  badge,
  actions,
}: {
  title: string;
  description?: React.ReactNode;
  badge?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 pb-1 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-[1.375rem] font-semibold leading-tight tracking-[-0.015em]">{title}</h1>
          {badge}
        </div>
        {description ? <p className="max-w-[70ch] text-[0.8125rem] leading-relaxed text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function MetaChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-sm border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
      {children}
    </span>
  );
}

/** A ruled settings block: label and explanation on the left, controls on the right at 1024px and up. */
export function SettingsSection({
  id,
  title,
  description,
  actions,
  children,
}: {
  id?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const generatedId = React.useId();
  const headingId = id ?? generatedId;
  return (
    <section aria-labelledby={headingId} className="grid gap-x-10 gap-y-4 border-t border-border pt-6 lg:grid-cols-[220px_minmax(0,1fr)]">
      <div className="space-y-1.5">
        <h2 id={headingId} className="text-sm font-semibold">
          {title}
        </h2>
        {description ? <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">{description}</p> : null}
        {actions ? <div className="flex flex-wrap items-center gap-2 pt-1">{actions}</div> : null}
      </div>
      <div className="min-w-0 space-y-4">{children}</div>
    </section>
  );
}

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
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={htmlFor} className="text-[0.8125rem] font-medium">
        {label}
        {required ? (
          <span className="ml-0.5 text-destructive" aria-hidden>
            *
          </span>
        ) : null}
      </Label>
      {children}
      {error ? (
        <p className="text-xs font-medium text-destructive">{error}</p>
      ) : description ? (
        <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
      ) : null}
    </div>
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
    <div className="sticky bottom-0 z-20 -mx-4 mt-8 border-t border-border bg-background px-4 py-3 md:-mx-6 md:px-6">
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

export function LoadingPage({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-8" aria-busy="true" aria-label="Loading settings">
      <div className="space-y-2 pb-1">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="grid gap-x-10 gap-y-4 border-t border-border pt-6 lg:grid-cols-[220px_minmax(0,1fr)]">
          <div className="space-y-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-3 w-40" />
          </div>
          <div className="space-y-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-px border-y border-border py-1" aria-busy="true" aria-label="Loading rows">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="flex h-10 items-center gap-4 px-2">
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-3.5 flex-1" />
          <Skeleton className="h-3.5 w-20" />
        </div>
      ))}
    </div>
  );
}

export function ErrorAlert({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3">
      <div className="flex items-start gap-2.5">
        <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium">Could not load this data</p>
          <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">
            {error} Check that the server is running, then try again.
          </p>
          {onRetry ? (
            <Button variant="outline" size="sm" className="mt-1" onClick={onRetry}>
              Try again
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 border-y border-border px-6 py-14 text-center">
      <div className="text-muted-foreground" aria-hidden>
        {icon ?? <Inbox className="size-5" />}
      </div>
      <p className="text-sm font-medium">{title}</p>
      {description ? <p className="max-w-[60ch] text-[0.8125rem] leading-relaxed text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

async function copyToClipboard(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    toast.success("Copied to clipboard");
  } catch {
    toast.error("Could not copy", { description: "Select the text and copy it manually." });
  }
}

export function CopyButton({
  value,
  label,
  size = "icon-sm",
  variant = "ghost",
  className,
}: {
  value: string;
  label?: string;
  size?: "icon" | "icon-sm" | "sm" | "default";
  variant?: "ghost" | "outline" | "secondary" | "default";
  className?: string;
}) {
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={className}
      onClick={() => void copyToClipboard(value)}
      title={label ?? "Copy"}
    >
      <Copy className="size-3.5" aria-hidden />
      {label ? <span>{label}</span> : <span className="sr-only">Copy</span>}
    </Button>
  );
}

export function SecretReveal({
  value,
  emptyLabel = "Not configured",
  warning,
}: {
  value: string | null | undefined;
  emptyLabel?: string;
  warning?: string;
}) {
  const [revealed, setRevealed] = React.useState(false);
  if (!value) return <p className="text-[0.8125rem] text-muted-foreground">{emptyLabel}</p>;
  const displayed = revealed ? value : "••••••••••••";
  return (
    <div className="space-y-1.5">
      <div className="flex min-w-0 items-center gap-1 border border-border bg-muted/40 py-1 pl-2 pr-1">
        <code className={cn("min-w-0 flex-1 truncate font-data text-xs", !revealed && "select-none")} title={revealed ? undefined : "Hidden"}>
          {displayed}
        </code>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => setRevealed((current) => !current)}
          title={revealed ? "Hide" : "Reveal"}
        >
          {revealed ? <EyeOff className="size-3.5" aria-hidden /> : <Eye className="size-3.5" aria-hidden />}
          <span className="sr-only">{revealed ? "Hide secret" : "Reveal secret"}</span>
        </Button>
        <CopyButton value={value} size="icon-sm" />
      </div>
      {warning ? <p className="text-xs leading-relaxed text-muted-foreground">{warning}</p> : null}
    </div>
  );
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  destructive,
  loading,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  children?: React.ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {children}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button variant={destructive ? "destructive" : "default"} onClick={onConfirm} disabled={loading}>
            {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Right-side detail panel. Use this instead of a modal when a form needs room. */
export function DetailSheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: "md" | "lg";
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className={cn("w-full gap-0 overflow-y-auto p-0", size === "lg" ? "sm:max-w-3xl" : "sm:max-w-xl")}
      >
        <SheetHeader className="border-b border-border px-5 py-4 pr-12">
          <SheetTitle className="text-base">{title}</SheetTitle>
          {description ? <SheetDescription className="leading-relaxed">{description}</SheetDescription> : null}
        </SheetHeader>
        <div className="flex-1 space-y-5 px-5 py-5">{children}</div>
        {footer ? (
          <SheetFooter className="sticky bottom-0 flex-row justify-end gap-2 border-t border-border bg-background px-5 py-3">
            {footer}
          </SheetFooter>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

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
