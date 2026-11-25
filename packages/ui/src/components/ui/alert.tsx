import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { useElementSlot } from "../../lib/element-slots"

const alertVariants = cva(
  "relative grid w-full grid-cols-[0_1fr] items-start gap-y-0.5 rounded-lg border px-4 py-3 text-sm has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] has-[>svg]:gap-x-3 [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current",
  {
    variants: {
      variant: {
        default: "bg-card text-card-foreground",
        destructive:
          "bg-card text-destructive *:data-[slot=alert-description]:text-destructive/90 [&>svg]:text-current",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Alert({
  className,
  style,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  const slot = useElementSlot(["alert"], alertVariants({ variant }), className, style, props)
  return (
    <div
      data-slot="alert"
      role="alert"
      className={slot.className}
      style={slot.style}
      {...props}
    />
  )
}

function AlertTitle({ className, style, ...props }: React.ComponentProps<"div">) {
  const slot = useElementSlot(["alertTitle"], "col-start-2 line-clamp-1 min-h-4 font-medium tracking-tight", className, style, props)
  return (
    <div
      data-slot="alert-title"
      className={slot.className}
      style={slot.style}
      {...props}
    />
  )
}

function AlertDescription({
  className,
  style,
  ...props
}: React.ComponentProps<"div">) {
  const slot = useElementSlot(["alertText"], "col-start-2 grid justify-items-start gap-1 text-sm text-muted-foreground [&_p]:leading-relaxed", className, style, props)
  return (
    <div
      data-slot="alert-description"
      className={slot.className}
      style={slot.style}
      {...props}
    />
  )
}

export { Alert, AlertTitle, AlertDescription }
