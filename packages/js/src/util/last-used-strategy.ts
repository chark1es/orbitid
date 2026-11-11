/**
 * The sign-in method the visitor completed last, remembered so the sign-in screen can label that
 * provider "Last used". Only a strategy name is stored: identifiers, emails and names never are.
 *
 * Storage is best effort. Private mode, blocked storage and SSR all fall back to "no memory" rather
 * than failing a sign-in that has already succeeded.
 */

const LAST_USED_KEY = "orbitid.last_used_strategy";
const PENDING_KEY = "orbitid.pending_sign_in_strategy";
const PENDING_TTL_MS = 10 * 60 * 1000;

/** The strategies the UI can label. A custom OAuth provider is `oauth_<provider>`. */
const STRATEGY = /^(?:password|email_code|email_link|phone_code|passkey|enterprise_sso|saml|oauth_[a-z][a-z0-9_]{0,63})$/;

function storage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    const candidate = window.localStorage;
    const probe = "__orbitid_storage_probe__";
    candidate.setItem(probe, "1");
    candidate.removeItem(probe);
    return candidate;
  } catch {
    return null;
  }
}

function isStrategy(value: unknown): value is string {
  return typeof value === "string" && STRATEGY.test(value);
}

/** True for a strategy the "Last used" badge may remember. */
export function isSignInStrategy(value: unknown): value is string {
  return isStrategy(value);
}

export function recordLastUsedStrategy(strategy: string): void {
  if (!isStrategy(strategy)) return;
  try {
    storage()?.setItem(LAST_USED_KEY, strategy);
  } catch {
    /* storage can fail after the probe: memory is optional */
  }
}

export function readLastUsedStrategy(): string | null {
  try {
    const value = storage()?.getItem(LAST_USED_KEY);
    return isStrategy(value) ? value : null;
  } catch {
    return null;
  }
}

export function clearLastUsedStrategy(): void {
  try {
    storage()?.removeItem(LAST_USED_KEY);
  } catch {
    /* nothing to clear when storage is unavailable */
  }
}

/**
 * A redirect leaves the page before the attempt can complete, so the strategy is held until the
 * sign-in returns or a polling attempt reports `complete`.
 */
export function rememberSignInStrategy(strategy: string): void {
  if (!isStrategy(strategy)) return;
  try {
    storage()?.setItem(PENDING_KEY, JSON.stringify({ strategy, at: Date.now() }));
  } catch {
    /* memory is optional */
  }
}

/** Promotes a fresh pending strategy to "last used" and clears it. */
export function commitPendingSignInStrategy(): void {
  let pending: string | null = null;
  try {
    const raw = storage()?.getItem(PENDING_KEY);
    storage()?.removeItem(PENDING_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { strategy?: unknown; at?: unknown };
    if (typeof parsed.at === "number" && Date.now() - parsed.at <= PENDING_TTL_MS && isStrategy(parsed.strategy)) {
      pending = parsed.strategy;
    }
  } catch {
    return;
  }
  if (pending) recordLastUsedStrategy(pending);
}

export function clearPendingSignInStrategy(): void {
  try {
    storage()?.removeItem(PENDING_KEY);
  } catch {
    /* memory is optional */
  }
}
