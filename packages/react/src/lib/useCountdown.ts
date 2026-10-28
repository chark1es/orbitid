import { useCallback, useEffect, useRef, useState } from "react";

export interface UseCountdownOptions {
  /** Start ticking on mount. Default `false`. */
  autoStart?: boolean;
}

export interface UseCountdownReturn {
  /** Seconds left (0 when finished). */
  remaining: number;
  isRunning: boolean;
  isComplete: boolean;
  /** (Re)start the countdown, optionally with a new duration. */
  start(seconds?: number): void;
  stop(): void;
  reset(seconds?: number): void;
}

/**
 * Resend timers for verification codes ("Didn't receive a code? Resend in 0:24").
 * Ticks once per second and cleans itself up on unmount.
 */
export function useCountdown(initialSeconds = 30, options: UseCountdownOptions = {}): UseCountdownReturn {
  const [duration, setDuration] = useState(initialSeconds);
  const [remaining, setRemaining] = useState(options.autoStart ? initialSeconds : 0);
  const [isRunning, setRunning] = useState(Boolean(options.autoStart));
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clear = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!isRunning) return;
    intervalRef.current = setInterval(() => {
      setRemaining((previous) => {
        if (previous <= 1) {
          clear();
          setRunning(false);
          return 0;
        }
        return previous - 1;
      });
    }, 1000);
    return clear;
  }, [isRunning, clear]);

  const start = useCallback((seconds?: number) => {
    const next = seconds ?? duration;
    setDuration(next);
    setRemaining(next);
    setRunning(next > 0);
  }, [duration]);

  const stop = useCallback(() => {
    clear();
    setRunning(false);
  }, [clear]);

  const reset = useCallback(
    (seconds?: number) => {
      stop();
      setDuration(seconds ?? initialSeconds);
      setRemaining(0);
    },
    [stop, initialSeconds],
  );

  return { remaining, isRunning, isComplete: !isRunning && remaining === 0, start, stop, reset };
}
