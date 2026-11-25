import * as React from "react"
import { useElementSlot } from "../../lib/element-slots"
import { XIcon } from "lucide-react"
import { Dialog as DialogPrimitive } from "radix-ui"

import { Button } from "./button"

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  style,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  const slot = useElementSlot(["modalBackdrop"], "fixed inset-0 z-50 bg-scrim data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-200 data-[state=open]:ease-out-expo data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-150 data-[state=closed]:ease-in-quick", className, style, props)
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={slot.className}
      style={slot.style}
      {...props}
    />
  )
}

function DialogContent({
  className,
  style,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
}) {
  const slot = useElementSlot(["modalContent"], "fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-xl border bg-popover p-6 text-popover-foreground shadow-overlay outline-none max-h-[calc(100dvh-2rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] overflow-y-auto overscroll-contain data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-97 data-[state=open]:slide-in-from-bottom-2 data-[state=open]:duration-200 data-[state=open]:ease-out-expo data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-98 data-[state=closed]:duration-150 data-[state=closed]:ease-in-quick sm:max-w-lg", className, style, props)
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={slot.className}
        style={slot.style}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="absolute top-3 right-3 inline-flex size-7 items-center justify-center rounded-sm text-muted-foreground opacity-80 transition-colors hover:bg-accent hover:text-foreground hover:opacity-100 focus:outline-hidden disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, style, ...props }: React.ComponentProps<"div">) {
  const slot = useElementSlot(["modalHeader"], "flex flex-col gap-2 text-center sm:text-left", className, style, props)
  return (
    <div
      data-slot="dialog-header"
      className={slot.className}
      style={slot.style}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  style,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  const slot = useElementSlot(["modalFooter"], "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className, style, props)
  return (
    <div
      data-slot="dialog-footer"
      className={slot.className}
      style={slot.style}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({
  className,
  style,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  const slot = useElementSlot(["modalTitle"], "text-lg leading-none font-heading", className, style, props)
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={slot.className}
      style={slot.style}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  style,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  const slot = useElementSlot(["modalDescription"], "text-sm text-muted-foreground", className, style, props)
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={slot.className}
      style={slot.style}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
