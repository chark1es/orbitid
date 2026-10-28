/** True in the browser (and jsdom), false during SSR. */
export function canUseDOM(): boolean {
  return typeof window !== "undefined" && typeof window.document !== "undefined";
}
