import { cn } from "../lib/utils"

/**
 * The OrbitID mascot: a blob with two eyes, wrapped by a ring. It comes in two drawings, one per scheme, traced from
 * the light and dark app icons (`assets/icon.svg`, `assets/icon-dark.svg`). Both sit in a 64-unit box, the box of the
 * app icon tile, so a glyph and its tile line up without a transform.
 */
export const ORBIT_GLYPH = {
  /** Ink blob on a paper tile. */
  light:
    "M29.76 53.13C26.84 52.98 23.80 52.11 21.63 50.79L21.29 50.58L20.25 50.61C13.86 50.79 8.80 48.46 7.38 44.69C6.59 42.58 7.27 40.08 9.30 37.66C10.46 36.29 11.90 35.07 13.99 33.69L14.57 33.31L15.23 31.89C16.29 29.61 16.56 28.91 17.11 27.00C17.96 24.07 18.55 22.66 19.61 21.05C22.02 17.38 25.87 14.70 29.96 13.84C30.81 13.67 31.45 13.59 32.41 13.56C34.36 13.50 35.85 13.79 37.40 14.53C39.00 15.30 39.87 16.10 41.50 18.28C42.82 20.05 43.54 20.78 45.26 22.07L45.81 22.49L46.49 22.49C50.26 22.50 53.64 23.81 55.35 25.93C57.67 28.81 57.64 32.81 55.27 36.39C54.09 38.16 52.20 40.04 50.11 41.51C49.72 41.79 49.52 41.97 49.49 42.06C49.40 42.40 48.92 43.53 48.60 44.19C47.26 46.86 45.17 48.89 42.14 50.47C38.57 52.32 33.85 53.34 29.76 53.13ZM23.02 46.76C31.85 46.12 42.70 42.41 48.10 38.18C50.88 36.01 52.51 33.29 52.51 30.82C52.51 28.38 50.80 26.59 48.09 26.17C47.87 26.14 47.85 26.15 47.89 26.24C48.14 26.85 48.53 28.19 48.69 28.96C48.84 29.66 48.87 30.71 48.75 31.17C48.05 34.00 43.11 37.17 35.36 39.74C27.58 42.32 20.06 43.43 16.77 42.47C14.88 41.92 14.21 40.92 14.10 38.51L14.07 37.67L13.58 38.17C10.83 40.97 11.08 44.13 14.18 45.67C15.28 46.21 16.91 46.60 18.74 46.75C19.57 46.82 22.12 46.82 23.02 46.76ZM30.48 32.74C31.02 32.49 31.49 31.83 31.72 31.01C31.87 30.48 31.93 29.33 31.84 28.74C31.51 26.59 30.02 25.55 28.83 26.64C27.41 27.94 27.59 31.73 29.12 32.68C29.56 32.95 30.00 32.97 30.48 32.74ZM39.45 31.76C41.03 30.95 41.32 27.30 39.91 25.79C39.23 25.06 38.34 25.08 37.65 25.83C37.16 26.37 36.90 27.09 36.83 28.14C36.67 30.68 37.98 32.50 39.45 31.76Z",
  /** Paper blob on an ink tile. */
  dark:
    "M28.80 51.95C25.67 51.73 22.82 50.85 21.03 49.54C20.88 49.43 20.78 49.42 19.76 49.39C13.77 49.20 9.38 46.89 8.27 43.36C7.19 39.90 9.88 35.83 14.95 33.26L15.61 32.92L15.83 32.34C15.94 32.02 16.25 31.28 16.51 30.70C17.48 28.53 17.87 27.43 18.32 25.64C18.94 23.15 19.43 21.89 20.36 20.38C21.59 18.36 23.49 16.56 25.53 15.46C28.54 13.84 32.20 13.55 35.12 14.71C36.60 15.29 37.37 15.89 38.92 17.62C40.50 19.38 41.12 19.95 43.03 21.36C44.63 22.55 45.81 23.86 46.52 25.24L46.84 25.85L47.39 25.89C52.68 26.24 56.03 28.97 56.00 32.91C55.98 36.37 53.20 39.98 48.50 42.66L48.01 42.94L47.69 43.56C45.61 47.72 40.90 50.62 34.60 51.64C32.87 51.93 30.34 52.06 28.80 51.95ZM23.21 44.63C27.47 44.51 33.93 43.24 38.85 41.57C44.86 39.53 49.22 36.67 50.62 33.85C50.96 33.17 51.07 32.79 51.11 32.11C51.14 31.45 51.07 31.07 50.78 30.50C50.41 29.76 49.76 29.15 48.82 28.67C48.33 28.42 47.77 28.21 47.72 28.26C47.70 28.27 47.74 28.53 47.80 28.83C48.12 30.39 48.10 31.45 47.74 32.53C46.27 36.95 38.34 41.02 27.70 42.80C23.70 43.47 20.20 43.67 18.69 43.30C17.34 42.97 15.70 41.45 15.15 40.02C14.81 39.13 14.70 37.47 14.89 36.03C14.93 35.72 14.95 35.45 14.95 35.43C14.91 35.39 14.20 35.97 13.70 36.47C11.75 38.35 11.48 40.52 13.00 42.15C14.13 43.36 16.17 44.17 18.93 44.52C19.59 44.61 21.68 44.71 22.08 44.67C22.17 44.67 22.68 44.65 23.21 44.63ZM30.80 31.98C31.58 31.53 31.87 30.68 31.82 29.07C31.77 27.81 31.63 27.34 31.16 26.82C30.21 25.79 28.79 26.38 28.40 27.97C28.21 28.73 28.37 30.49 28.68 31.10C29.15 32.03 30.07 32.41 30.80 31.98ZM39.57 31.17C40.35 30.77 40.68 29.96 40.68 28.44C40.67 27.12 40.50 26.49 40.01 25.98C39.02 24.96 37.56 25.64 37.24 27.25C37.15 27.74 37.16 28.95 37.27 29.45C37.58 30.89 38.61 31.66 39.57 31.17Z",
} as const

/** Tile colours of the app icon. Fixed brand colours, not theme tokens, so the icon matches the favicon and README. */
export const APP_ICON_COLORS = {
  light: { tile: "#f9f6f2", glyph: "#1a1512" },
  dark: { tile: "#1a1512", glyph: "#f9f6f2" },
} as const

export type OrbitScheme = keyof typeof ORBIT_GLYPH

/**
 * The bare mascot in `currentColor` (or `color`), with the eyes and the gap under the ring cut out. By default it draws
 * the light glyph and switches to the dark one under the `dark:` variant, so it follows the nearest scheme class;
 * `scheme` pins one drawing when the surface does not follow the theme.
 */
export function OrbitMark({
  className,
  title,
  color = "currentColor",
  scheme,
}: {
  className?: string
  title?: string
  color?: string
  scheme?: OrbitScheme
}) {
  return (
    <svg
      viewBox="0 0 64 64"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      className={cn("size-4 shrink-0", className)}
    >
      {title ? <title>{title}</title> : null}
      {scheme ? (
        <path data-part="glyph" data-scheme={scheme} d={ORBIT_GLYPH[scheme]} fill={color} />
      ) : (
        <>
          <path data-part="glyph" data-scheme="light" className="dark:hidden" d={ORBIT_GLYPH.light} fill={color} />
          <path data-part="glyph" data-scheme="dark" className="hidden dark:inline" d={ORBIT_GLYPH.dark} fill={color} />
        </>
      )}
    </svg>
  )
}

/**
 * The app icon: the mascot on its rounded tile, light on paper and dark on ink. It follows the nearest scheme class
 * like `OrbitMark`; `scheme` pins one. Use it where the product itself is named (the rail, the sign-in page).
 */
export function AppIcon({ className, title, scheme }: { className?: string; title?: string; scheme?: OrbitScheme }) {
  const tile = (which: OrbitScheme, schemeClass?: string) => (
    <g data-part="tile" data-scheme={which} className={schemeClass}>
      <rect width="64" height="64" rx="14" fill={APP_ICON_COLORS[which].tile} />
      <path d={ORBIT_GLYPH[which]} fill={APP_ICON_COLORS[which].glyph} />
    </g>
  )
  return (
    <svg
      viewBox="0 0 64 64"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      className={cn("size-7 shrink-0", className)}
    >
      {title ? <title>{title}</title> : null}
      {scheme ? (
        tile(scheme)
      ) : (
        <>
          {tile("light", "dark:hidden")}
          {tile("dark", "hidden dark:inline")}
        </>
      )}
    </svg>
  )
}
