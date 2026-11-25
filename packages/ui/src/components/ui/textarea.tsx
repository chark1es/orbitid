import * as React from "react"
import { useElementSlot } from "../../lib/element-slots"

function Textarea({ className, style, ...props }: React.ComponentProps<"textarea">) {
  const slot = useElementSlot(["input", "textarea"], "flex field-sizing-content min-h-16 w-full rounded-md border border-input bg-(--input-background) text-(color:--input-foreground) px-2.5 py-2 text-sm shadow-xs transition-[color,border-color,box-shadow] placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive", className, style, props)
  return (
    <textarea
      data-slot="textarea"
      className={slot.className}
      style={slot.style}
      {...props}
    />
  )
}

export { Textarea }
