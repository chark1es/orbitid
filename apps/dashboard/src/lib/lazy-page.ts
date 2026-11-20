import { createContext, createElement, useContext, useEffect, useState, type ComponentType, type ReactNode } from "react";

export type LazyPage<P extends object = object> = ((props: P) => ReactNode) & {
  /** Starts downloading the page's code; safe to call any number of times. */
  preload: () => void;
};

/** What a page shows while its code downloads; set by the layout that renders it. */
export const PageFallback = createContext<ReactNode>(null);

/**
 * A code-split page that never suspends.
 *
 * With `lazy()` the page suspends on its first render, and once React has shown a Suspense fallback it holds the real
 * content back until the fallback has been visible for ~300 ms, so it does not flash. Every reload and every first
 * visit to a page paid that, even with the chunk in cache, and the page's own data requests waited behind it. This
 * renders the layout's {@link PageFallback} while the code loads and the page the moment it is ready.
 *
 * The current route is preloaded at boot and sidebar links preload on hover, so the fallback is rarely seen at all.
 */
export function lazyPage<P extends object = object>(load: () => Promise<{ default: ComponentType<P> }>): LazyPage<P> {
  let loaded: ComponentType<P> | null = null;
  let loading: Promise<ComponentType<P>> | null = null;
  const start = () =>
    (loading ??= load().then(
      (module) => (loaded = module.default),
      (error: unknown) => {
        // A failed download (an upgrade replaced the chunk, a blip) is retried by the next attempt.
        loading = null;
        throw error;
      },
    ));

  function Page(props: P) {
    const fallback = useContext(PageFallback);
    const [component, setComponent] = useState<ComponentType<P> | null>(() => loaded);
    const [failure, setFailure] = useState<{ error: unknown } | null>(null);
    useEffect(() => {
      if (component) return;
      let live = true;
      start().then(
        (ready) => live && setComponent(() => ready),
        (error: unknown) => live && setFailure({ error }),
      );
      return () => {
        live = false;
      };
    }, [component]);
    // Same as a rejected `lazy()`: the nearest error boundary handles it.
    if (failure) throw failure.error;
    return component ? createElement(component, props) : fallback;
  }

  return Object.assign(Page, {
    preload: () => {
      start().catch(() => {});
    },
  });
}
