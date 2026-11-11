import { afterEach, vi } from "vitest";
import { cleanup, configure } from "@testing-library/react";

/**
 * `findBy*`/`waitFor` default to a 1s window. These suites run beside every other workspace, and a page
 * that loads a record and then the active tab's list needs two serialized request/render rounds, so a
 * loaded machine can exceed 1s without any UI bug. Give the async utilities headroom below
 * `testTimeout` rather than encoding a timeout in each test that happens to be slow that day.
 */
configure({ asyncUtilTimeout: 5_000 });

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

if (!("ResizeObserver" in globalThis)) {
  Object.defineProperty(globalThis, "ResizeObserver", { value: ResizeObserverStub, writable: true });
}

if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

Object.defineProperty(window, "scrollTo", { value: () => {}, writable: true });

// Radix Select asks the pointer capture and scroll APIs of the element it opened from; jsdom has neither.
if (!("hasPointerCapture" in HTMLElement.prototype)) {
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", { value: () => false, writable: true });
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { value: () => {}, writable: true });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", { value: () => {}, writable: true });
}

if (!("scrollIntoView" in HTMLElement.prototype)) {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { value: () => {}, writable: true });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // A test that enables fake timers and throws before its `finally` must not freeze the next test.
  vi.useRealTimers();
  sessionStorage.clear();
  localStorage.clear();
});
