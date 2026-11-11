import { Toaster } from "@orbitid/ui";

/**
 * Toasts are anchored under the 48px top bar, not at the bottom edge: a sheet or the SSO wizard owns
 * the bottom of the screen, and its footer (Back / Cancel / Create) must stay clickable while an error
 * toast is visible. 56px clears the bar with an 8px gap.
 */
export const TOASTER_POSITION = "top-right" as const;
export const TOASTER_OFFSET = { top: 56, right: 16 } as const;

export function DashboardToaster() {
  return <Toaster position={TOASTER_POSITION} offset={TOASTER_OFFSET} closeButton />;
}
