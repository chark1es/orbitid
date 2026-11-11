import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { useUrlSyncedInput } from "./hooks";

function Harness({ commit }: { commit: (value: string) => void }) {
  const [committed, setCommitted] = useState("");
  const [value, setValue] = useUrlSyncedInput(committed, (next) => {
    setCommitted(next);
    commit(next);
  }, 300);
  return (
    <div>
      <input aria-label="search" value={value} onChange={(event) => setValue(event.target.value)} />
      <output data-testid="committed">{committed}</output>
      <button type="button" onClick={() => setCommitted("from-url")}>
        external-url
      </button>
    </div>
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("useUrlSyncedInput", () => {
  it("keeps typing during the debounce window after a URL commit", async () => {
    vi.useFakeTimers();
    const commit = vi.fn();
    render(<Harness commit={commit} />);
    const input = screen.getByLabelText("search");

    fireEvent.change(input, { target: { value: "a" } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(commit).toHaveBeenLastCalledWith("a");

    // Keep typing while the first commit's URL round-trip is still settling.
    fireEvent.change(input, { target: { value: "ab" } });
    await act(async () => {
      vi.advanceTimersByTime(150);
    });
    expect((screen.getByLabelText("search") as HTMLInputElement).value).toBe("ab");

    await act(async () => {
      vi.advanceTimersByTime(150);
    });
    expect(commit).toHaveBeenLastCalledWith("ab");
    expect((screen.getByLabelText("search") as HTMLInputElement).value).toBe("ab");
  });

  it("adopts a URL value that this field did not commit, such as the back button", () => {
    const commit = vi.fn();
    render(<Harness commit={commit} />);

    fireEvent.click(screen.getByRole("button", { name: "external-url" }));

    expect((screen.getByLabelText("search") as HTMLInputElement).value).toBe("from-url");
  });
});
