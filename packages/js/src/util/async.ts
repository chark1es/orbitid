// `Promise.withResolvers` is Node 22+; OrbitID supports Node 20.
export function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Wait `ms`, but stop waiting as soon as `signal` aborts.
 *
 * A retry back-off must not keep a timer (and the closure that goes with it) alive after the caller has
 * aborted: the request is over, and resolving early is what lets the caller observe the abort immediately.
 */
export function delayWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return delay(ms);
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal!.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
    // `abort()` between the check above and the subscription would otherwise wait out the whole back-off.
    if (signal.aborted) done();
  });
}
