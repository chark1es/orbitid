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

  const stepFromLocation = useCallback((): TStep | null => {
    if (typeof window === "undefined" || routing === "virtual") return null;
    const slug = readSlug(routing, path, window.location);
    if (!slug) return initialStep;
    const match = steps.find((step) => slugify(step) === slug);
    return match ?? null;
  }, [routing, path, steps, slugify, initialStep]);

  const [step, setStepState] = useState<TStep>(() => stepFromLocation() ?? initialStep);

  const setStep = useCallback(
    (next: TStep) => {
      setStepState(next);
      if (routing === "virtual" || typeof window === "undefined") return;
      const slug = slugify(next);
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
    [routing, path, slugify, runtime],
  );

  useEffect(() => {
    if (routing === "virtual" || typeof window === "undefined") return;
    const sync = () => {
      const next = stepFromLocation();
      if (next) setStepState(next);
    };
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, [routing, stepFromLocation]);

  return { step, setStep, slug: slugify(step) };
}
