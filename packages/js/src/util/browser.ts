/** True when running in a browser (SSR-safe: never touches `window` at import time beyond a typeof check). */
export const inBrowser = typeof window !== "undefined" && typeof window.document !== "undefined";

export function isValidBrowserOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine !== false;
}

export function isWebAuthnSupported(): boolean {
  return (
    inBrowser &&
    typeof window.PublicKeyCredential !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.credentials
  );
}

export async function isWebAuthnAutofillSupported(): Promise<boolean> {
  if (!isWebAuthnSupported()) return false;
  if (typeof PublicKeyCredential.isConditionalMediationAvailable !== "function") return false;
  try {
    return await PublicKeyCredential.isConditionalMediationAvailable();
  } catch {
    return false;
  }
}

export async function isWebAuthnPlatformAuthenticatorSupported(): Promise<boolean> {
  if (!isWebAuthnSupported()) return false;
  if (typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable !== "function") return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}
