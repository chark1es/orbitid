import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { useElementSlot, slotKeysFor } from "../../lib/element-slots"
import { Slot } from "radix-ui"

const badgeVariants = cva(
  "inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-sm border border-transparent px-1.5 text-xs font-medium whitespace-nowrap leading-none control-optical transition-colors [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a&]:hover:bg-primary/90",
        secondary:
          "bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/80",
        destructive:
          "bg-destructive text-destructive-foreground [a&]:hover:bg-destructive/90",
        outline:
          "border-border text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        ghost: "[a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        link: "text-primary underline decoration-border underline-offset-4 [a&]:hover:decoration-current",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  style,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  const slot = useElementSlot(slotKeysFor("badge", variant), badgeVariants({ variant }), className, style, props)
  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={slot.className}
      style={slot.style}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
