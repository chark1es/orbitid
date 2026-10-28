import { useCallback, useRef } from "react";
import { isReverificationError } from "../lib/errors";
import { useReverificationUI } from "../provider/reverification";

export interface UseReverificationOptions {
  /** Called before the modal opens (e.g. to close a dialog first). */
  onNeedsReverification?(error: unknown): void;
  /** Called when the user dismisses the modal. */
  onCancel?(): void;
  /** Rethrow the original error on cancel. Default `true`. */
  throwOnCancel?: boolean;
}

/**
 * Wrap an SDK action so a `session_reverification_required` failure opens the verification
 * modal and retries once the user verifies.
 *
 * ```tsx
 * const updatePassword = useReverification((params) => user.updatePassword(params));
 * await updatePassword({ currentPassword, newPassword });
 * ```
 *
 * `<UserVerificationModal/>` (W7) registers the modal through `useRegisterReverificationUI`.
 */
export function useReverification<Args extends unknown[], Result>(
  fetcher: (...args: Args) => Promise<Result>,
  options: UseReverificationOptions = {},
): (...args: Args) => Promise<Result> {
  const ui = useReverificationUI();
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  return useCallback(
    async (...args: Args): Promise<Result> => {
      try {
        return await fetcherRef.current(...args);
      } catch (error) {
        if (!isReverificationError(error)) throw error;
        optionsRef.current.onNeedsReverification?.(error);
        const verified = await ui.show({ error });
        if (!verified) {
          optionsRef.current.onCancel?.();
          if (optionsRef.current.throwOnCancel === false) {
            // `throwOnCancel: false` opts into `undefined` for a cancelled reverification.
            return undefined as Result;
          }
          throw error;
        }
        return await fetcherRef.current(...args);
      }
    },
    [ui],
  );
}
