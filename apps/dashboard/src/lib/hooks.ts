import { useCallback, useEffect, useRef, useState } from "react";

export function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/**
 * A text field whose committed value lives in the URL. The field owns the draft while someone types; the URL
 * only feeds it back when the URL actually moved (back button, Clear, a shared link) to a value this field did
 * not just commit. That prevents a debounced commit, or a filter change, from clobbering fast typing.
 */
export function useUrlSyncedInput(
  committedValue: string,
  commit: (value: string) => void,
  delay = 300,
): [string, (value: string) => void] {
  const [value, setValue] = useState(committedValue);
  const lastCommitted = useRef(committedValue);
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const debounced = useDebounced(value.trim(), delay);

  useEffect(() => {
    if (debounced === lastCommitted.current) return;
    lastCommitted.current = debounced;
    commitRef.current(debounced);
  }, [debounced]);

  useEffect(() => {
    if (committedValue === lastCommitted.current) return;
    lastCommitted.current = committedValue;
    setValue(committedValue);
  }, [committedValue]);

  return [value, setValue];
}

/**
 * A flag that turns itself off after `ms`, such as the "Copied" tick on a copy button. One timer at a time, so a
 * second click restarts the interval instead of cutting it short, and it is cleared on unmount.
 */
export function useFlash(ms = 1500): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const flash = useCallback(() => {
    setOn(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOn(false), ms);
  }, [ms]);
  return [on, flash];
}

export function useCopyToClipboard(): (text: string) => Promise<boolean> {
  return async (text: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Fall through to the legacy path (insecure context / permission denied).
    }
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const copied = document.execCommand("copy");
      document.body.removeChild(area);
      return copied;
    } catch {
      return false;
    }
  };
}

/** Element ids for label/description wiring without repeating string templates across forms. */
export function fieldIds(id: string) {
  return { input: id, error: `${id}-error`, description: `${id}-description` };
}
