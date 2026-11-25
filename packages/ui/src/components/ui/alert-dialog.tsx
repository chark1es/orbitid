import * as React from "react"
import { cn } from "../../lib/utils"
import { useElementSlot } from "../../lib/element-slots"
import { AlertDialog as AlertDialogPrimitive } from "radix-ui"

import { Button } from "./button"

function AlertDialog({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Root>) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />
}

function AlertDialogTrigger({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Trigger>) {
  return (
    <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />
  )
}

function AlertDialogPortal({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Portal>) {
  return (
    <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />
  )
}

function AlertDialogOverlay({
  className,
  style,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Overlay>) {
  const slot = useElementSlot(["modalBackdrop"], "fixed inset-0 z-50 bg-scrim data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-200 data-[state=open]:ease-out-expo data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-150 data-[state=closed]:ease-in-quick", className, style, props)
  return (
    <AlertDialogPrimitive.Overlay
      data-slot="alert-dialog-overlay"
      className={slot.className}
      style={slot.style}
      {...props}
    />
  )
}

function AlertDialogContent({
  className,
  style,
  size = "default",
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content> & {
  size?: "default" | "sm"
}) {
  const slot = useElementSlot(["modalContent"], "group/alert-dialog-content fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-xl border bg-popover p-6 text-popover-foreground shadow-overlay outline-none data-[size=sm]:max-w-xs max-h-[calc(100dvh-2rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] overflow-y-auto overscroll-contain data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-97 data-[state=open]:slide-in-from-bottom-2 data-[state=open]:duration-200 data-[state=open]:ease-out-expo data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-98 data-[state=closed]:duration-150 data-[state=closed]:ease-in-quick data-[size=default]:sm:max-w-lg", className, style, props)
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Content
        data-slot="alert-dialog-content"
        data-size={size}
        className={slot.className}
        style={slot.style}
        {...props}
      />
    </AlertDialogPortal>
  )
}

function AlertDialogHeader({
  className,
  style,
  ...props
}: React.ComponentProps<"div">) {
  const slot = useElementSlot(["modalHeader"], "grid grid-rows-[auto_1fr] place-items-center gap-1.5 text-center has-data-[slot=alert-dialog-media]:grid-rows-[auto_auto_1fr] has-data-[slot=alert-dialog-media]:gap-x-6 sm:group-data-[size=default]/alert-dialog-content:place-items-start sm:group-data-[size=default]/alert-dialog-content:text-left sm:group-data-[size=default]/alert-dialog-content:has-data-[slot=alert-dialog-media]:grid-rows-[auto_1fr]", className, style, props)
  return (
    <div
      data-slot="alert-dialog-header"
      className={slot.className}
      style={slot.style}
      {...props}
    />
  )
}

function AlertDialogFooter({
  className,
  style,
  ...props
}: React.ComponentProps<"div">) {
  const slot = useElementSlot(["modalFooter"], "flex flex-col-reverse gap-2 group-data-[size=sm]/alert-dialog-content:grid group-data-[size=sm]/alert-dialog-content:grid-cols-2 sm:flex-row sm:justify-end", className, style, props)
  return (
    <div
      data-slot="alert-dialog-footer"
      className={slot.className}
      style={slot.style}
      {...props}
    />
  )
}

function AlertDialogTitle({
  className,
  style,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
  const slot = useElementSlot(["modalTitle"], "text-lg font-heading sm:group-data-[size=default]/alert-dialog-content:group-has-data-[slot=alert-dialog-media]/alert-dialog-content:col-start-2", className, style, props)
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={slot.className}
      style={slot.style}
      {...props}
    />
  )
}

function AlertDialogDescription({
  className,
  style,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
  const slot = useElementSlot(["modalDescription"], "text-sm text-muted-foreground", className, style, props)
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={slot.className}
      style={slot.style}
      {...props}
    />
  )
}

function AlertDialogMedia({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-media"
      className={cn(
        "mb-2 inline-flex size-16 items-center justify-center rounded-md bg-muted sm:group-data-[size=default]/alert-dialog-content:row-span-2 *:[svg:not([class*='size-'])]:size-8",
        className
      )}
      {...props}
    />
  )
}

function AlertDialogAction({
  className,
  variant = "default",
  size = "default",
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Action> &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size">) {
  return (
    <Button variant={variant} size={size} asChild>
      <AlertDialogPrimitive.Action
        data-slot="alert-dialog-action"
        className={cn(className)}
        {...props}
      />
    </Button>
  )
}

function AlertDialogCancel({
  className,
  variant = "outline",
  size = "default",
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Cancel> &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size">) {
  return (
    <Button variant={variant} size={size} asChild>
      <AlertDialogPrimitive.Cancel
        data-slot="alert-dialog-cancel"
        className={cn(className)}
        {...props}
      />
    </Button>
  )
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
}
