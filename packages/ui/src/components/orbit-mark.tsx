import { cn } from "../lib/utils"

/**
 * The OrbitID mark: a ring and a dot. One drawing for the rail, the sign-in page and the auth
 * card, so the brand never drifts between surfaces. It inherits `currentColor`, which lets a
 * caller place it on paper, on the charcoal rail or on a branded button.
 */
export function OrbitMark({
  className,
  title,
  color = "currentColor",
}: {
  className?: string
  title?: string
  color?: string
}) {
  return (
    <svg
      viewBox="0 0 32 32"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      className={cn("size-4 shrink-0", className)}
    >
      {title ? <title>{title}</title> : null}
      <circle cx="16" cy="16" r="9" fill="none" stroke={color} strokeWidth="2.5" />
      <circle cx="16" cy="16" r="2.5" fill={color} />
    </svg>
  )
}
