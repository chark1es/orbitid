import { useEffect, useMemo, useState } from "react";
import { decodeJwt } from "../lib/jwt";
import { deriveSessionClaims } from "./auth";
import type { OrbitIDInstance, OrganizationResource, SessionClaims, SessionResource } from "./types";

const sameClaims = (a: SessionClaims | null, b: SessionClaims | null): boolean =>
  a === b || (a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b));

export interface UseSessionClaimsInput {
  instance: OrbitIDInstance | null;
  session: SessionResource | null;
  organization: OrganizationResource | null;
  initialStateClaims?: SessionClaims | null;
  /** Instance event counter — re-read the token whenever SDK state changes. */
  version: number;
}

/**
 * Session JWT claims backing `useAuth()` (`org_role`, `org_permissions`, `fva`, `act`).
 * Prefers `session.lastActiveToken`, otherwise asks the SDK for a (cached) token; falls back
 * to the claims derivable from the session/organization resources.
 */
export function useSessionClaims(input: UseSessionClaimsInput): SessionClaims | null {
  const { instance, session, organization, initialStateClaims, version } = input;
  const [claims, setClaims] = useState<SessionClaims | null>(() => initialStateClaims ?? null);
  const derived = useMemo(() => deriveSessionClaims(session, organization), [session, organization]);

  useEffect(() => {
    if (!instance || !session) {
      const fallback = initialStateClaims ?? null;
      setClaims((previous) => (sameClaims(previous, fallback) ? previous : fallback));
      return;
    }

    const inlineToken = session.lastActiveToken?.jwt;
    const inlineClaims = decodeJwt<SessionClaims>(inlineToken);
    if (inlineClaims) {
      setClaims((previous) => (sameClaims(previous, inlineClaims) ? previous : inlineClaims));
      return;
    }

    const getToken = session.getToken;
    // SDK shape guard: a partially initialised session must not crash `useAuth`.
    if (typeof getToken !== "function") return;

    let cancelled = false;
    Promise.resolve(getToken.call(session))
      .then((token) => {
        const decoded = decodeJwt<SessionClaims>(token ?? null);
        if (!cancelled && decoded) {
          setClaims((previous) => (sameClaims(previous, decoded) ? previous : decoded));
        }
      })
      .catch(() => {
        // Offline / expired token: derived claims keep `useAuth` usable.
      });
    return () => {
      cancelled = true;
    };
  }, [instance, session, version, initialStateClaims]);

  return claims ?? derived;
}
