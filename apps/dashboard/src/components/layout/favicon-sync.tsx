import { useEffect } from "react";
import { useTheme } from "@orbitid/ui";

/**
 * Keeps the tab icon on the dashboard's theme rather than the system's. `index.html` ships a light and a dark icon
 * link and picks one before first paint; this turns the matching one on again whenever the theme changes.
 */
export function syncFavicon(theme: "light" | "dark", doc: Document = document): void {
  for (const icon of doc.querySelectorAll<HTMLLinkElement>('link[rel="icon"][data-scheme]')) {
    icon.media = icon.dataset.scheme === theme ? "all" : "not all";
  }
}

export function FaviconSync() {
  const { resolvedTheme } = useTheme();
  useEffect(() => syncFavicon(resolvedTheme), [resolvedTheme]);
  return null;
}
