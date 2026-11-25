/**
 * Client-side check for an operator-configured billing-portal URL (organizations and OAuth applications). The
 * server enforces the same rule (and more: no credentials, no private addresses); this only catches typos early.
 * Returns an error message, or `null` when the value is empty (clears the portal) or an absolute https URL.
 */
export function billingPortalUrlError(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:") return "The billing portal URL must start with https://.";
    if (url.username || url.password) return "The billing portal URL must not contain a username or password.";
    return null;
  } catch {
    return "The billing portal URL must be an absolute https URL.";
  }
}

/** The PATCH value for a billing-portal field: `null` clears it. */
export function billingPortalUrlValue(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
