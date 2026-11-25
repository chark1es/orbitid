"use client"

import * as React from "react"
import { useElementSlot } from "../../lib/element-slots"
import { Separator as SeparatorPrimitive } from "radix-ui"

function Separator({
  className,
  style,
  orientation = "horizontal",
  decorative = true,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  const slot = useElementSlot(["separator"], "shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px", className, style, props)
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={slot.className}
      style={slot.style}
      {...props}
    />
  )
}

export { Separator }
