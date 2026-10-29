import { createContext } from "react";
import { resolveAppearance } from "../appearance/resolve";
import type { ResolvedAppearance } from "../appearance/types";
import { enUS } from "../localization/enUS";
import { createTranslator } from "../localization/translate";
import type { LocalizationContextValue } from "../localization/types";
import { createAuthState } from "./auth";
import type {
  AuthState,
  ClientResource,
  OrbitIDInstance,
  OrbitIDOptionsContextValue,
  OrbitIDStatusContextValue,
  OrganizationResource,
  SessionResource,
  UserResource,
} from "./types";

/** The live `@orbitid/js` instance; `null` while rendering on the server without `orbit`. */
export const OrbitIDContext = createContext<OrbitIDInstance | null>(null);

export const ClientContext = createContext<ClientResource | null>(null);
export const SessionContext = createContext<SessionResource | null>(null);
export const UserContext = createContext<UserResource | null>(null);
export const OrganizationContext = createContext<OrganizationResource | null>(null);

/** `useAuth()`-shaped state; always defined (safe defaults outside a provider). */
export const AuthContext = createContext<AuthState>(
  createAuthState({
    loaded: false,
    session: null,
    user: null,
    organization: null,
    claims: null,
    instance: null,
  }),
);

export const OrbitIDOptionsContext = createContext<OrbitIDOptionsContextValue>({
  publishableKey: "",
  instance: null,
});

/** Merged `appearance` (theme + prop overrides) used by every component. */
export const AppearanceContext = createContext<ResolvedAppearance>(resolveAppearance());

/** Active dictionary + interpolation helper. */
export const LocalizationContext = createContext<LocalizationContextValue>({
  locale: enUS.locale ?? "en-US",
  resource: enUS,
  t: createTranslator(enUS),
});

/** Load state for `<OrbitIDLoaded/>`, `<OrbitIDLoading/>`, `<OrbitIDFailed/>`. */
export const StatusContext = createContext<OrbitIDStatusContextValue>({ status: "loading", error: null, retry: () => {} });

/** Older name for the provider options context. */
export const OptionsContext = OrbitIDOptionsContext;
