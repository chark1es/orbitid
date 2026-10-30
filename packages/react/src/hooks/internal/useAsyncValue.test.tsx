import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { useAsyncValue } from "./useAsyncValue";

it("does not cache a response that completes after unmount", async () => {
  let resolve!: (value: string) => void;
  const pending = new Promise<string>((done) => { resolve = done; });
  const { unmount } = renderHook(() => useAsyncValue({ key: "unmounted-response", fetcher: () => pending }));
  unmount();
  await act(async () => { resolve("private data"); await pending; });
  const next = renderHook(() => useAsyncValue<string>({ key: "unmounted-response", fetcher: null, enabled: false }));
  expect(next.result.current.data).toBeNull();
});

it("ignores a stale response when the resource key changes", async () => {
  let resolve!: (value: string) => void;
  const pending = new Promise<string>((done) => { resolve = done; });
  const hook = renderHook(({ id }) => useAsyncValue({ key: id, fetcher: () => id === "first" ? pending : Promise.resolve("current") }), { initialProps: { id: "first" } });
  hook.rerender({ id: "second" });
  await waitFor(() => expect(hook.result.current.data).toBe("current"));
  await act(async () => { resolve("stale"); await pending; });
  expect(hook.result.current.data).toBe("current");
});
