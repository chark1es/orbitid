import type { ReactNode } from "react";
import { cn } from "@orbitid/ui";

/**
 * The one page rhythm: title row, then the first content block 24px below it, then sections 24px
 * apart. Every dashboard page wraps its content in this so the gap does not depend on whether the
 * page carries a description, an action button or an extra toolbar.
 */
export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div data-slot="page" className={cn("flex flex-col gap-6", className)}>
      {children}
    </div>
  );
}
