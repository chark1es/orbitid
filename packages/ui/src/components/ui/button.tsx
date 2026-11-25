import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { useElementSlot, slotKeysFor } from "../../lib/element-slots"
import { CONTROL_RECIPE } from "../../lib/control"
import { Slot } from "radix-ui"

const buttonVariants = cva(
  `${CONTROL_RECIPE} shrink-0 gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow] duration-150 select-none disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4`,
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-xs hover:bg-primary/88 active:bg-primary/82",
        destructive:
          "bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90",
        outline:
          "border border-border bg-card shadow-xs hover:bg-accent hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline decoration-border underline-offset-4 hover:decoration-current",
      },
      size: {
        default: "h-[34px] px-3.5 has-[>svg]:px-3",
        xs: "h-6 gap-1 px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1.5 px-2.5 text-[0.8125rem] has-[>svg]:px-2",
        lg: "h-[38px] px-4 has-[>svg]:px-3.5",
        icon: "size-[34px] p-0",
        "icon-xs": "size-6 p-0 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7 p-0",
        "icon-lg": "size-[38px] p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  style,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  const slot = useElementSlot(slotKeysFor("button", variant), buttonVariants({ variant, size }), className, style, props)
  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={slot.className}
      style={slot.style}
      {...props}
    />
  )
}

export { Button, buttonVariants }
