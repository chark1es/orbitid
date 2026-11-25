import { useElementSlot } from "../../lib/element-slots"

function Skeleton({ className, style, ...props }: React.ComponentProps<"div">) {
  const slot = useElementSlot(["skeleton"], "animate-pulse rounded-md bg-accent", className, style, props)
  return (
    <div
      data-slot="skeleton"
      className={slot.className}
      style={slot.style}
      {...props}
    />
  )
}

export { Skeleton }
