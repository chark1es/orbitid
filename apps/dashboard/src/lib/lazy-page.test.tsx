import { Suspense } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { lazyPage, PageFallback } from "./lazy-page";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const Hello = ({ name }: { name: string }) => <p>Hello {name}</p>;

describe("lazyPage", () => {
  it("shows the layout's fallback, never a Suspense one, until the code arrives", async () => {
    const chunk = deferred<{ default: typeof Hello }>();
    const Page = lazyPage(() => chunk.promise);
    render(
      <PageFallback.Provider value={<p>Loading page</p>}>
        <Suspense fallback={<p>Suspended</p>}>
          <Page name="Ada" />
        </Suspense>
      </PageFallback.Provider>,
    );
    expect(screen.getByText("Loading page")).toBeTruthy();
    expect(screen.queryByText("Suspended")).toBeNull();
    chunk.resolve({ default: Hello });
    expect(await screen.findByText("Hello Ada")).toBeTruthy();
  });

  it("renders a preloaded page on the first render", async () => {
    const load = vi.fn(() => Promise.resolve({ default: Hello }));
    const Page = lazyPage(load);
    Page.preload();
    Page.preload();
    await Promise.resolve();
    await Promise.resolve();
    render(
      <PageFallback.Provider value={<p>Loading page</p>}>
        <Page name="Grace" />
      </PageFallback.Provider>,
    );
    expect(screen.getByText("Hello Grace")).toBeTruthy();
    expect(screen.queryByText("Loading page")).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("retries a download that failed during preload", async () => {
    const load = vi
      .fn<() => Promise<{ default: typeof Hello }>>()
      .mockRejectedValueOnce(new Error("chunk missing"))
      .mockResolvedValue({ default: Hello });
    const Page = lazyPage(load);
    Page.preload();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    render(<Page name="Lin" />);
    expect(await screen.findByText("Hello Lin")).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
  });
});
