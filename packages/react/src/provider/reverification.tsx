import { createContext, useContext, useEffect, useRef } from "react";
import type { ReverificationLevel } from "@orbitid/shared";

export interface ReverificationRequest {
  /** The API error that triggered reverification (`session_reverification_required`). */
  error?: unknown;
  level?: ReverificationLevel;
  afterMinutes?: number;
}

/** Resolves `true` when the user verified, `false` when they cancelled. */
export type ReverificationHandler = (request: ReverificationRequest) => Promise<boolean>;

export interface ReverificationUI {
  /** Opens the verification modal and resolves with the user's answer. */
  show(request?: ReverificationRequest): Promise<boolean>;
  /** Mount a modal handler; returns an unregister function. */
  register(handler: ReverificationHandler): () => void;
  readonly isRegistered: boolean;
}

/** Registry shared by `useReverification()` (consumer) and `<UserVerificationModal/>` (provider). */
export function createReverificationUI(): ReverificationUI {
  let handler: ReverificationHandler | null = null;
  return {
    get isRegistered() {
      return handler !== null;
    },
    register(next) {
      handler = next;
      return () => {
        if (handler === next) handler = null;
      };
    },
    show(request) {
      if (!handler) {
        return Promise.reject(
          new Error(
            "[OrbitID] Reverification is required but no verification UI is mounted. Render <UserVerificationModal/> inside <OrbitIDProvider/>, or register a handler with useRegisterReverificationUI().",
          ),
        );
      }
      return handler(request ?? {});
    },
  };
}

export const ReverificationContext = createContext<ReverificationUI>(createReverificationUI());

/** Read the registry (used by `useReverification`). */
export function useReverificationUI(): ReverificationUI {
  return useContext(ReverificationContext);
}

/**
 * Register the verification modal's handler for the lifetime of the calling component.
 * The latest `handler` is always used, so modals can close over fresh state without
 * re-registering on every render.
 */
export function useRegisterReverificationUI(handler: ReverificationHandler): void {
  const ui = useReverificationUI();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => ui.register((request) => handlerRef.current(request)), [ui]);
}
