import * as React from "react"
import { cn } from "../../lib/utils"
import { Switch as SwitchPrimitive } from "radix-ui"

function Switch({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default"
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "peer group/switch inline-flex shrink-0 items-center rounded-full border border-transparent p-px transition-all outline-none disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-5 data-[size=default]:w-9 data-[size=sm]:h-4 data-[size=sm]:w-7 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          // Travel is the inner track width minus the thumb: 36 - 2 (border) - 2 (padding) - 16 = 16px
          // at the default size, and 28 - 2 - 2 - 12 = 12px at sm. On the height the same arithmetic
          // (20 - 2 - 2 = 16 at the default size, 16 - 2 - 2 = 12 at sm) is exactly the thumb, so the
          // thumb fills the inner height with no vertical slack; using the full track width overshoots
          // the far padding.
          "pointer-events-none block rounded-full bg-background ring-0 transition-transform group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 data-[state=checked]:translate-x-4 group-data-[size=sm]/switch:data-[state=checked]:translate-x-3 rtl:data-[state=checked]:-translate-x-4 group-data-[size=sm]/switch:rtl:data-[state=checked]:-translate-x-3 data-[state=unchecked]:translate-x-0"
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
