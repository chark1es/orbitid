import { useCallback, useContext, useMemo, useState } from "react";
import { LocalizationContext } from "../provider/contexts";
import { handleOrbitError, type FieldErrors } from "./errors";

export type LoadingStatus = "idle" | "loading" | "error" | "success";

export interface RunOptions {
  /** Map API field names to form field names. */
  fieldAliases?: Record<string, string>;
  onSuccess?(result: unknown): void;
  onError?(error: unknown): void;
}

export interface UseLoadingStatusReturn {
  status: LoadingStatus;
  isLoading: boolean;
  isIdle: boolean;
  isSuccess: boolean;
  isError: boolean;
  /** Original thrown value, for callers that need the code. */
  error: unknown;
  fieldErrors: FieldErrors;
  globalError: string | null;
  setStatus(status: LoadingStatus): void;
  reset(): void;
  /**
   * Run a submit action. Errors are captured in `status`/`fieldErrors`/`globalError`
   * instead of being rethrown; resolves to `undefined` on failure.
   */
  run<T>(action: () => Promise<T>, options?: RunOptions): Promise<T | undefined>;
}

/**
 * Submit-state helper for the auth/organization forms: one place for the pending flag,
 * the mapped field errors and the global error message.
 */
export function useLoadingStatus(): UseLoadingStatusReturn {
  const { t } = useContext(LocalizationContext);
  const [state, setState] = useState<{
    status: LoadingStatus;
    error: unknown;
    fieldErrors: FieldErrors;
    globalError: string | null;
  }>({ status: "idle", error: null, fieldErrors: {}, globalError: null });

  const setStatus = useCallback((status: LoadingStatus) => {
    setState((previous) => ({ ...previous, status }));
  }, []);

  const reset = useCallback(() => {
    setState({ status: "idle", error: null, fieldErrors: {}, globalError: null });
  }, []);

  const run = useCallback(
    async <T,>(action: () => Promise<T>, options: RunOptions = {}): Promise<T | undefined> => {
      setState({ status: "loading", error: null, fieldErrors: {}, globalError: null });
      try {
        const result = await action();
        setState({ status: "success", error: null, fieldErrors: {}, globalError: null });
        options.onSuccess?.(result);
        return result;
      } catch (error) {
        const { fieldErrors, globalError } = handleOrbitError(error, undefined, {
          t,
          fieldAliases: options.fieldAliases,
        });
        setState({ status: "error", error, fieldErrors, globalError });
        options.onError?.(error);
        return undefined;
      }
    },
    [t],
  );

  return useMemo(
    () => ({
      ...state,
      isLoading: state.status === "loading",
      isIdle: state.status === "idle",
      isSuccess: state.status === "success",
      isError: state.status === "error",
      setStatus,
      reset,
      run,
    }),
    [state, setStatus, reset, run],
  );
}
