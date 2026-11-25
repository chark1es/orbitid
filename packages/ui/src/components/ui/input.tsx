import * as React from "react"
import { useElementSlot } from "../../lib/element-slots"

// Inputs keep a normal line box. The control-optical trim (line-height 1, cap/alphabetic edges)
// suits one-line labels but clips the descenders of typed text, like the "g" and "@" in an email.

function Input({ className, style, type, ...props }: React.ComponentProps<"input">) {
  const slot = useElementSlot(["input"], ["h-[34px] w-full min-w-0 rounded-md border border-input bg-(--input-background) text-(color:--input-foreground) px-2.5 py-0 text-sm leading-normal shadow-xs transition-[color,border-color,box-shadow] file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50", "aria-invalid:border-destructive"], className, style, props)
  return (
    <input
      type={type}
      data-slot="input"
      className={slot.className}
      style={slot.style}
      {...props}
    />
  )
}

export { Input }
