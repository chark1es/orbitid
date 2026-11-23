/**
 * The light/dark scheme of the page the components are mounted in.
 *
 * Most apps that support both schemes mark the active one on `<html>`: a `dark` or `light` class (Tailwind,
 * `@orbitid/ui`'s ThemeProvider, next-themes), a `data-theme` attribute, or an inline `color-scheme`. When the page
 * says which scheme it shows, the components follow it, so a visitor who picked "light" in the app does not get a
 * dark sign-in card because their operating system is dark. A page that marks nothing falls back to
 * `prefers-color-scheme`.
 */

export type PageScheme = "light" | "dark";

/** What the page itself declares on `<html>`, or `null` when it declares nothing. */
export function declaredPageScheme(): PageScheme | null {
  if (typeof document === "undefined") return null;
  const root = document.documentElement;
  if (root.classList.contains("dark")) return "dark";
  if (root.classList.contains("light")) return "light";
  const attribute = root.getAttribute("data-theme");
  if (attribute === "dark" || attribute === "light") return attribute;
  const scheme = root.style.colorScheme;
  if (scheme === "dark" || scheme === "light") return scheme;
  return null;
}

export function systemScheme(): PageScheme {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/**
 * `useSyncExternalStore` snapshot: `"<declared>:<system>"`, a primitive so identity only changes with a value.
 * `declared` is `none` when the page marks no scheme.
 */
export function pageSchemeSnapshot(): string {
  return `${declaredPageScheme() ?? "none"}:${systemScheme()}`;
}

/** The server knows neither the page's class nor the visitor's scheme: render light, then correct after hydration. */
export function serverPageSchemeSnapshot(): string {
  return "none:light";
}

export function parsePageSchemeSnapshot(snapshot: string): { declared: PageScheme | null; system: PageScheme } {
  const [declared, system] = snapshot.split(":");
  return {
    declared: declared === "dark" || declared === "light" ? declared : null,
    system: system === "dark" ? "dark" : "light",
  };
}

/** Re-render when the page switches scheme (a theme toggle) or the operating system does. */
export function subscribePageScheme(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const query = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  query?.addEventListener?.("change", listener);
  const observer =
    typeof MutationObserver === "function" && typeof document !== "undefined" ? new MutationObserver(listener) : null;
  observer?.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
  return () => {
    query?.removeEventListener?.("change", listener);
    observer?.disconnect();
  };
}
