import * as React from "react";

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
