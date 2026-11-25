import * as React from "react"
import { useElementSlot } from "../../lib/element-slots"
import { CheckIcon } from "lucide-react"
import { Checkbox as CheckboxPrimitive } from "radix-ui"

function Checkbox({
  className,
  style,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  const slot = useElementSlot(["checkbox"], "peer inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input transition-colors outline-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground dark:data-[state=checked]:bg-primary", className, style, props)
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={slot.className}
      style={slot.style}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex size-full items-center justify-center text-current transition-none"
      >
        <CheckIcon className="size-3.5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
