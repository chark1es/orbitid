import * as React from "react"
import { cn } from "../../lib/utils"
import { useElementSlot } from "../../lib/element-slots"
import { OTPInput, OTPInputContext } from "input-otp"
import { MinusIcon } from "lucide-react"

function InputOTP({
  className,
  containerClassName,
  containerElement,
  ...props
}: React.ComponentProps<typeof OTPInput> & {
  containerClassName?: string
  /**
   * Element key for the container row that holds the slot groups. Its className and `unstyled` apply to the row;
   * the input library's container takes no `style`, so a style override does not reach it.
   */
  containerElement?: string
}) {
  const container = useElementSlot(
    [],
    "flex items-center gap-2 has-disabled:opacity-50",
    containerClassName,
    undefined,
    containerElement ? { "data-orbitid-element": containerElement } : undefined
  )
  return (
    <OTPInput
      data-slot="input-otp"
      containerClassName={container.className}
      className={cn("disabled:cursor-not-allowed", className)}
      {...props}
    />
  )
}

// The group and slots declare no primitive key of their own; a caller's explicit key (`data-orbitid-element`) still
// gets its className, style and `unstyled` here.
function InputOTPGroup({ className, style, ...props }: React.ComponentProps<"div">) {
  const slot = useElementSlot([], "flex items-center", className, style, props)
  return (
    <div
      data-slot="input-otp-group"
      className={slot.className}
      style={slot.style}
      {...props}
    />
  )
}

function InputOTPSlot({
  index,
  className,
  style,
  ...props
}: React.ComponentProps<"div"> & {
  index: number
}) {
  const inputOTPContext = React.useContext(OTPInputContext)
  const { char, hasFakeCaret, isActive } = inputOTPContext?.slots[index] ?? {}
  const slot = useElementSlot(
    [],
    "relative flex size-[34px] items-center justify-center border-y border-r border-input text-sm transition-colors first:rounded-l-md first:border-l last:rounded-r-md aria-invalid:border-destructive data-[active=true]:z-10 data-[active=true]:border-ring data-[active=true]:aria-invalid:border-destructive",
    className,
    style,
    props
  )

  return (
    <div
      data-slot="input-otp-slot"
      data-active={isActive}
      className={slot.className}
      style={slot.style}
      {...props}
    >
      {char}
      {hasFakeCaret && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-4 w-px animate-caret-blink bg-foreground duration-1000" />
        </div>
      )}
    </div>
  )
}

function InputOTPSeparator({ ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="input-otp-separator" role="separator" {...props}>
      <MinusIcon />
    </div>
  )
}

export { InputOTP, InputOTPGroup, InputOTPSlot, InputOTPSeparator }
