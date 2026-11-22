import { cn } from "../lib/utils"

/**
 * The OrbitID mark: an orbit ring broken where a satellite passes, around a solid core. One drawing
 * for the rail, the sign-in page, the auth card and the favicon, so the brand never drifts between
 * surfaces. It inherits `currentColor`, which lets a caller place it on paper, on the charcoal rail
 * or on a branded button; `accent` recolours only the core (the app icon sets it to signal red).
 *
 * Geometry (32-unit box): ring radius 10 centred at 16,16, open 56 degrees around the satellite at
 * the upper right (-45 degrees), so the satellite reads as moving along the ring rather than sitting
 * on it.
 */
export function OrbitMark({
  className,
  title,
  color = "currentColor",
  accent,
}: {
  className?: string
  title?: string
  color?: string
  /** Fill for the core. Defaults to `color`. */
  accent?: string
}) {
  return (
    <svg
      viewBox="0 0 32 32"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      className={cn("size-4 shrink-0", className)}
    >
      {title ? <title>{title}</title> : null}
      <path
        data-part="orbit"
        d="M25.56 13.08 A10 10 0 1 1 18.92 6.44"
        fill="none"
        stroke={color}
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <circle data-part="satellite" cx="23.07" cy="8.93" r="2.6" fill={color} />
      <circle data-part="core" cx="16" cy="16" r="3.25" fill={accent ?? color} />
    </svg>
  )
}
