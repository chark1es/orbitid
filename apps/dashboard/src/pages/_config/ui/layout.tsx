import * as React from "react";
import { PageHeader as SharedPageHeader } from "../../../components/shared/page-header";

export function PageHeader({
  title,
  description,
  descriptionClassName,
  badge,
  actions,
}: {
  title: string;
  description?: React.ReactNode;
  descriptionClassName?: string;
  badge?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <SharedPageHeader
      title={title}
      description={description}
      descriptionClassName={descriptionClassName}
      badge={badge}
      actions={actions}
    />
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
    <section
      aria-labelledby={headingId}
      // Right under the page header, whose own bottom rule already divides the page: no second line.
      className="grid gap-x-10 gap-y-4 border-t border-border pt-6 lg:grid-cols-[220px_minmax(0,1fr)] [[data-slot=page-header]+&]:border-t-0 [[data-slot=page-header]+&]:pt-0"
    >
      <div className="space-y-1.5">
        <h2 id={headingId} className="text-[0.9375rem] font-heading tracking-[-0.01em]">
          {title}
        </h2>
        {description ? <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">{description}</p> : null}
        {actions ? <div className="flex flex-wrap items-center gap-2 pt-1">{actions}</div> : null}
      </div>
      <div className="min-w-0 space-y-4">{children}</div>
    </section>
  );
}
