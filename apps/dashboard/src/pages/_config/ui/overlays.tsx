import * as React from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  cn,
} from "@orbitid/ui";
import { OVERLAY_WIDTH } from "../../../components/shared/overlay-sizes";

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
        className={cn("w-full gap-0 overflow-y-auto p-0", size === "lg" ? OVERLAY_WIDTH.detail : OVERLAY_WIDTH.sheet)}
      >
        <SheetHeader className="border-b border-border px-5 pt-[calc(1rem+env(safe-area-inset-top))] pb-4 pr-12">
          <SheetTitle className="text-base">{title}</SheetTitle>
          {description ? <SheetDescription className="leading-relaxed">{description}</SheetDescription> : null}
        </SheetHeader>
        <div className={cn("flex-1 space-y-5 px-5 py-5", footer && "pb-24")}>{children}</div>
        {footer ? (
          <SheetFooter className="sticky bottom-0 flex-row justify-end gap-2 border-t border-border bg-popover px-5 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
            {footer}
          </SheetFooter>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
