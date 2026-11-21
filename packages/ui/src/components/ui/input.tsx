import * as React from "react"
import { cn } from "../../lib/utils"

// Inputs keep a normal line box. The control-optical trim (line-height 1, cap/alphabetic edges)
// suits one-line labels but clips the descenders of typed text, like the "g" and "@" in an email.

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-[34px] w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 py-0 text-sm leading-normal transition-colors file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  )
}

export { Input }
