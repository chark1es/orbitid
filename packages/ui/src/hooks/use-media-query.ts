"use client"

import * as React from "react"

/**
 * Subscribes to a media query. The first render is the wide layout, which matches server and test
 * output; the browser flips to the narrow layout after mount. Used by tables that become stacked
 * rows below `sm` rather than a horizontally scrolling table.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = React.useState(false)

  React.useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange()
    mql.addEventListener?.("change", onChange)
    return () => mql.removeEventListener?.("change", onChange)
  }, [query])

  return matches
}
