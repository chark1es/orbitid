import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

/**
 * A native date input reports each keystroke of the year segment as a four-digit year, so typing
 * `2026` passes through `0002`, `0020` and `0202`. Those values are complete ISO dates but not a
 * date an operator meant to filter by, so require a plausible year before committing the filter.
 */
export function isCompleteDateInput(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  if (Number(value.slice(0, 4)) < 1000) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Local draft for a date filter. The URL filter stays the source of truth, but the input is edited
 * from a draft so an incomplete value is never written back into the query string and then replaced
 * under the caret. External changes (Clear, back button) still resynchronise the draft.
 */
export function useDateInputDraft(stored: string): [string, Dispatch<SetStateAction<string>>] {
  const [draft, setDraft] = useState(stored);
  useEffect(() => setDraft(stored), [stored]);
  return [draft, setDraft];
}
