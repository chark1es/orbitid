import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

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
  sessionStorage.clear();
  localStorage.clear();
});
