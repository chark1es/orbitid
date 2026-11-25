"use client"

import * as React from "react"
import { useElementSlot } from "../../lib/element-slots"
import { Label as LabelPrimitive } from "radix-ui"

function Label({
  className,
  style,
  ...props
}: React.ComponentProps<typeof LabelPrimitive.Root>) {
  const slot = useElementSlot(["label"], "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50", className, style, props)
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={slot.className}
      style={slot.style}
      {...props}
    />
  )
}

export { Label }
