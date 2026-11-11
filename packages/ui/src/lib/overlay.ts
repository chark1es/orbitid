/**
 * Overlay widths, one set for every OrbitID surface (dashboard and SDK widgets). DESIGN.md shapes:
 * 448 confirm/small form, 576 sheet form, 768 read-only detail and the wizard. Tailwind class strings
 * stay static so the compiler still sees them.
 */
export const OVERLAY_WIDTH = {
  /** Confirmation dialogs and small single-column forms. */
  form: "sm:max-w-md",
  /** Sheet forms with a short grid of fields. */
  sheet: "sm:max-w-xl",
  /** Read-only detail views and the multi-step wizard. */
  detail: "sm:max-w-3xl",
} as const;
