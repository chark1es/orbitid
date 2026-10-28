import type { ReactNode } from "react";
import { cn } from "@orbitid/ui";

/** A ruled section: heading, optional description and actions, then content. No card. */
export function Section({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("border-t border-border pt-5", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3 pb-3">
        <div className="min-w-0 space-y-1">
          <h2 className="text-[0.9375rem] font-semibold tracking-[-0.01em] text-foreground">{title}</h2>
          {description ? (
            <p className="max-w-[70ch] text-sm leading-6 text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** Bordered block for a form or a small readout. Tables bring their own border. */
export function Panel({
  children,
  className,
  muted = false,
}: {
  children: ReactNode;
  className?: string;
  muted?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-[4px] border border-border",
        muted ? "bg-muted/30" : "bg-card",
        className,
      )}
    >
      {children}
    </div>
  );
}
