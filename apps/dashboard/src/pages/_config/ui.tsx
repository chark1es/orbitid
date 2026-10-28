import * as React from "react";
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Skeleton,
  Switch,
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
  description?: string;
  badge?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {badge}
        </div>
        {description ? <p className="max-w-3xl text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function SectionCard({
  title,
  description,
  actions,
  children,
  footer,
  className,
  contentClassName,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <Card className={cn("gap-4 py-5", className)}>
      {title || description || actions ? (
        <CardHeader className="gap-1">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              {title ? <CardTitle>{title}</CardTitle> : null}
              {description ? <CardDescription>{description}</CardDescription> : null}
            </div>
            {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
          </div>
        </CardHeader>
      ) : null}
      <CardContent className={cn("space-y-5", contentClassName)}>{children}</CardContent>
      {footer ? <CardFooter className="border-t pt-4">{footer}</CardFooter> : null}
    </Card>
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
      <Label htmlFor={htmlFor}>
        {label}
        {required ? <span className="ml-0.5 text-destructive">*</span> : null}
      </Label>
      {children}
      {error ? (
        <p className="text-xs font-medium text-destructive">{error}</p>
      ) : description ? (
        <p className="text-xs text-muted-foreground">{description}</p>
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
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border px-4 py-3">
      <div className="space-y-0.5">
        <Label htmlFor={id} className="text-sm font-medium">
          {label}
        </Label>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} className="mt-0.5" />
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
    <label className={cn("flex cursor-pointer items-start gap-3 rounded-md px-1 py-1.5", disabled && "cursor-not-allowed opacity-60")}>
      <Checkbox
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      />
      <span className="space-y-0.5">
        <span className="block text-sm font-medium leading-5">{label}</span>
        {description ? <span className="block text-xs text-muted-foreground">{description}</span> : null}
      </span>
    </label>
  );
}

export function SaveBar({
  dirty,
  saving,
  disabled,
  onSave,
  onDiscard,
  saveLabel = "Save changes",
}: {
  dirty: boolean;
  saving: boolean;
  disabled?: boolean;
  onSave: () => void | Promise<boolean | void>;
  onDiscard: () => void;
  saveLabel?: string;
}) {
  if (!dirty && !saving) return null;
  return (
    <div className="sticky bottom-4 z-20 mt-6">
      <div className="flex flex-col gap-3 rounded-xl border bg-background/95 px-4 py-3 shadow-lg backdrop-blur sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 text-sm">
          <span className="size-2 rounded-full bg-amber-500" aria-hidden />
          <span className="font-medium">Unsaved changes</span>
          <span className="text-muted-foreground">Review before saving.</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onDiscard} disabled={saving}>
            Discard
          </Button>
          <Button size="sm" onClick={() => void onSave()} disabled={saving || disabled || !dirty}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
            {saving ? "Saving…" : saveLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function LoadingPage({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      {Array.from({ length: rows }).map((_, index) => (
        <Card key={index} className="gap-4 py-5">
          <CardHeader>
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-72 max-w-full" />
          </CardHeader>
          <CardContent className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-2/3" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, index) => (
        <Skeleton key={index} className="h-11 w-full" />
      ))}
    </div>
  );
}

export function ErrorAlert({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <Alert variant="destructive">
      <AlertCircle />
      <AlertDescription className="flex flex-wrap items-center gap-3">
        <span>{error}</span>
        {onRetry ? (
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
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
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-12 text-center">
      <div className="text-muted-foreground">{icon ?? <Inbox className="size-6" />}</div>
      <p className="font-medium">{title}</p>
      {description ? <p className="max-w-md text-sm text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

async function copyToClipboard(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    toast.success("Copied to clipboard");
  } catch {
    toast.error("Could not copy to clipboard");
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
  size?: "icon" | "icon-sm" | "icon-xs" | "sm" | "default";
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
      <Copy className="size-3.5" />
      {label ? <span>{label}</span> : <span className="sr-only">Copy</span>}
    </Button>
  );
}

export function SecretReveal({
  value,
  emptyLabel = "Not configured",
  mono = true,
}: {
  value: string | null | undefined;
  emptyLabel?: string;
  mono?: boolean;
}) {
  const [revealed, setRevealed] = React.useState(false);
  if (!value) return <Badge variant="outline">{emptyLabel}</Badge>;
  const displayed = revealed ? value : "••••••••••••";
  return (
    <div className="flex min-w-0 items-center gap-1 rounded-md border bg-muted/40 px-2 py-1">
      <code className={cn("min-w-0 truncate text-xs", mono && "font-mono")} title={revealed ? undefined : "Hidden"}>
        {displayed}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={() => setRevealed((current) => !current)}
        title={revealed ? "Hide" : "Reveal"}
      >
        {revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
        <span className="sr-only">{revealed ? "Hide secret" : "Reveal secret"}</span>
      </Button>
      <CopyButton value={value} size="icon-xs" />
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
            {loading ? <Loader2 className="size-4 animate-spin" /> : null}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
        className={cn("min-h-40 font-mono text-xs leading-relaxed", error && "border-destructive", className)}
        aria-invalid={Boolean(error)}
        {...props}
      />
      {error ? <p className="text-xs font-medium text-destructive">{error}</p> : null}
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
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => onChange(values.filter((_, itemIndex) => itemIndex !== index))}
            title="Remove"
          >
            <X className="size-4" />
            <span className="sr-only">Remove</span>
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={() => onChange([...values, ""])}>
        <Plus className="size-4" />
        {addLabel}
      </Button>
    </div>
  );
}

export function EndpointRow({ label, description, url }: { label: string; description?: string; url: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium">{label}</p>
        <code className="block truncate text-xs text-muted-foreground">{url}</code>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <CopyButton value={url} size="icon-sm" variant="outline" />
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  const positive = ["active", "success", "enabled", "verified", "accepted", "complete"].includes(normalized);
  const negative = ["failed", "revoked", "disabled", "expired", "rejected", "banned", "locked"].includes(normalized);
  return (
    <Badge variant={positive ? "default" : negative ? "destructive" : "secondary"} className="capitalize">
      {normalized.replace(/_/g, " ")}
    </Badge>
  );
}
