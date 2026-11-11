import { useCallback, useEffect, useMemo, useState } from "react";
import type { AuthRouting } from "./types";
import { useAuthRuntime } from "./w6";

export interface StepRoutingOptions<TStep extends string> {
  routing?: AuthRouting;
  path?: string;
  steps: readonly TStep[];
  initialStep: TStep;
  /** Override the URL slug of a step. `"start"` defaults to the bare `path`. */
  slugFor?: (step: TStep) => string;
}

export interface StepRouting<TStep extends string> {
  step: TStep;
  setStep: (step: TStep) => void;
  /** Slug of the current step, ready for `<title>`/debugging. */
  slug: string;
}

/** How long a step the router was asked for outranks the URL it has not updated yet. */
const TRANSITION_TTL_MS = 5_000;

interface StepTransition {
  from: string;
  to: string;
  step: string;
  at: number;
}

/**
 * The last step each widget navigated to, kept outside React on purpose. Some routers (the Next.js
 * App Router renders a catch-all auth route this way) remount the page before they update
 * `window.location`; the fresh mount would then read the slug of the step that was just left and
 * paint that step again. The requested step is the truth until the URL catches up — or until the
 * short window in which that can happen has passed, so a later visit to the old URL is not hijacked.
 */
const transitions = new Map<string, StepTransition>();

/** Test helper: forget pending step transitions. */
export function resetStepTransitions(): void {
  transitions.clear();
}

function kebab(step: string): string {
  return step.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`).replace(/^-/, "");
}

function readSlug(routing: AuthRouting, path: string | undefined, location: Location): string {
  if (routing === "hash") {
    const hash = location.hash.replace(/^#\/?/, "");
    return hash;
  }
  if (routing === "virtual") return "";
  const base = (path ?? "").replace(/\/$/, "");
  let pathname = location.pathname.replace(/\/$/, "");
  if (base && pathname.startsWith(base)) pathname = pathname.slice(base.length);
  return pathname.replace(/^\//, "");
}

/**
 * Step state machine with optional URL mirroring (`path` / `hash`) and back/forward support.
 * Steps are ordinary strings; the component decides how each renders.
 */
export function useStep<TStep extends string>({
  routing = "path",
  path,
  steps,
  initialStep,
  slugFor,
}: StepRoutingOptions<TStep>): StepRouting<TStep> {
  const runtime = useAuthRuntime();
  const slugify = useMemo(() => slugFor ?? ((step: TStep) => (step === "start" ? "" : kebab(step))), [slugFor]);
  const transitionKey = `${routing}:${path ?? ""}`;

  const stepFromLocation = useCallback((): TStep | null => {
    if (typeof window === "undefined" || routing === "virtual") return null;
    const slug = readSlug(routing, path, window.location);
    if (!slug) return initialStep;
    const match = steps.find((step) => slugify(step) === slug);
    return match ?? null;
  }, [routing, path, steps, slugify, initialStep]);

  const [step, setStepState] = useState<TStep>(() => {
    if (typeof window !== "undefined" && routing !== "virtual") {
      const pending = transitions.get(transitionKey);
      if (pending) {
        const slug = readSlug(routing, path, window.location);
        const fresh = Date.now() - pending.at < TRANSITION_TTL_MS;
        // `from` is the URL this mount may still see while the router finishes the transition.
        if (fresh && (slug === pending.from || slug === pending.to)) return pending.step as TStep;
        transitions.delete(transitionKey);
      }
    }
    return stepFromLocation() ?? initialStep;
  });

  const setStep = useCallback(
    (next: TStep) => {
      setStepState(next);
      if (routing === "virtual" || typeof window === "undefined") return;
      const slug = slugify(next);
      transitions.set(transitionKey, {
        from: readSlug(routing, path, window.location),
        to: slug,
        step: next,
        at: Date.now(),
      });
      const base = path ?? window.location.pathname.replace(/\/$/, "");
      if (routing === "hash") {
        const nextHash = slug ? `#/${slug}` : "";
        const nextUrl = `${base}${nextHash}`;
        runtime.navigate(nextUrl);
        return;
      }
      const nextUrl = slug ? `${base}/${slug}` : base;
      if (window.location.pathname !== nextUrl) runtime.navigate(nextUrl);
    },
    [routing, path, slugify, runtime, transitionKey],
  );

  useEffect(() => {
    if (routing === "virtual" || typeof window === "undefined") return;
    const sync = () => {
      // Back/forward is an explicit step choice: it outranks a transition still in flight.
      transitions.delete(transitionKey);
      const next = stepFromLocation();
      if (next) setStepState(next);
    };
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, [routing, stepFromLocation, transitionKey]);

  return { step, setStep, slug: slugify(step) };
}
