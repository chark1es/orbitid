import { decodePublishableKey } from "@orbitid/shared";
import type { UserJSON } from "@orbitid/shared";
import type { OrbitInstance, OrbitUser, SignInFactorView } from "../w6";
import type { SignInResource, VerificationLike } from "../types";
import { isRecord } from "../guards";
import { AuthUIError, toAuthError } from "./errors";
import { unwrap } from "./client";

// ---------- identity helpers ----------

export function primaryIdentifier(user: OrbitUser | null): string {
  if (!user) return "";
  const emails = user.email_addresses ?? [];
  const primaryEmail = emails.find((email) => email.id === user.primary_email_address_id) ?? emails[0];
  if (primaryEmail) return primaryEmail.email_address;
  const phones = user.phone_numbers ?? [];
  const primaryPhone = phones.find((phone) => phone.id === user.primary_phone_number_id) ?? phones[0];
  if (primaryPhone) return primaryPhone.phone_number;
  return user.username ?? "";
}

export function displayName(user: UserJSON | OrbitUser | null): string {
  if (!user) return "";
  const name = [user.first_name, user.last_name].filter((part): part is string => Boolean(part)).join(" ");
  return name || user.username || primaryIdentifier(user as OrbitUser);
}

export function initials(user: UserJSON | OrbitUser | null): string {
  if (!user) return "?";
  const parts = [user.first_name, user.last_name].filter((part): part is string => Boolean(part));
  if (parts.length > 0) return parts.map((part) => part.charAt(0).toUpperCase()).join("");
  const identifier = primaryIdentifier(user as OrbitUser);
  return identifier.charAt(0).toUpperCase() || "?";
}

export function factorsOf(signIn: SignInResource | null, kind: "first" | "second"): SignInFactorView[] {
  const list = kind === "first" ? signIn?.supported_first_factors : signIn?.supported_second_factors;
  return Array.isArray(list) ? list : [];
}

export function verificationStatus(verification: unknown): VerificationLike["status"] | null {
  return isRecord(verification) && typeof verification.status === "string"
    ? (verification.status as VerificationLike["status"])
    : null;
}

export function isTransferable(signIn: SignInResource | null): boolean {
  return (
    verificationStatus(signIn?.first_factor_verification) === "transferable" ||
    verificationStatus(signIn?.second_factor_verification) === "transferable"
  );
}

export function apiOrigin(orbit: OrbitInstance): string {
  const candidates = [orbit.frontendApi, orbit.frontendApiUrl, orbit.apiUrl];
  if (typeof orbit.publishableKey === "string") {
    try {
      candidates.push(decodePublishableKey(orbit.publishableKey).frontendApi);
    } catch {
      // Not a publishable key (tests/custom instances): fall through.
    }
  }
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate.replace(/\/$/, "");
  }
  return "";
}

export async function apiRequest<T = unknown>(
  orbit: OrbitInstance,
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const origin = apiOrigin(orbit);
  const url = origin ? `${origin}${path}` : path;
  const { json, ...requestInit } = init ?? {};
  const headers = new Headers(requestInit.headers);
  let body = requestInit.body;
  if (json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(json);
  }
  const response = await fetch(url, { credentials: "include", ...requestInit, headers, body });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    if (isRecord(payload) && Array.isArray(payload.errors)) throw toAuthError(payload);
    throw new AuthUIError("unexpected", `Request failed with status ${response.status}`);
  }
  const unwrapped = unwrap(payload);
  return unwrapped as T;
}
