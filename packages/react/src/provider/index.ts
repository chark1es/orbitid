export * from "./types";
export * from "./contexts";
export { OrbitIDProvider } from "./OrbitIDProvider";
export {
  createReverificationUI,
  ReverificationContext,
  useRegisterReverificationUI,
  useReverificationUI,
  type ReverificationHandler,
  type ReverificationRequest,
  type ReverificationUI,
} from "./reverification";
export {
  createServerOrbitID,
  getInstanceStore,
  getOrbitIDInstance,
  loadOrbitID,
  resetOrbitIDInstances,
  type InstanceStore,
} from "./instance";
export { buildSnapshot, checkHas, createAuthState, deriveSessionClaims, readFeatures, type HasContext } from "./auth";
export { useSessionClaims } from "./useSessionClaims";
// Re-exported so components can reach the appearance/localization/router helpers from the
// provider module they already depend on (same declarations as the barrels).
export { useAppearance, useElementClasses } from "../appearance/useAppearance";
export { useLocalizations } from "../localization/useLocalizations";
export { usePathRouting, useRouter } from "../lib/routing";
