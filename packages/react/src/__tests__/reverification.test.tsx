import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { useReverification } from "../hooks/useReverification";
import { useRegisterReverificationUI } from "../provider/reverification";
import { createFakeOrbitID, renderWithProvider } from "./helpers";

const reverificationError = () => ({
  errors: [{ code: "session_reverification_required", message: "Please verify your identity" }],
});

function Modal({ answer, onShow }: { answer: boolean; onShow?: () => void }) {
  useRegisterReverificationUI(async () => {
    onShow?.();
    return answer;
  });
  return null;
}

function Probe({
  fetcher,
  onResult,
  throwOnCancel,
}: {
  fetcher: () => Promise<string>;
  onResult: (result: string) => void;
  throwOnCancel?: boolean;
}) {
  const run = useReverification(fetcher, { throwOnCancel });
  const [pending, setPending] = useState(false);
  return (
    <button
      disabled={pending}
      onClick={() => {
        setPending(true);
        void run().then(
          (value) => onResult(`ok:${String(value)}`),
          (error: unknown) =>
            onResult(`error:${error instanceof Error ? error.message : JSON.stringify(error)}`),
        );
      }}
    >
      run
    </button>
  );
}

describe("useReverification", () => {
  it("passes successful calls straight through", async () => {
    const fetcher = vi.fn(async () => "value");
    const onShow = vi.fn();
    const results: string[] = [];

    renderWithProvider(
      <>
        <Modal answer onShow={onShow} />
        <Probe fetcher={fetcher} onResult={(result) => results.push(result)} />
      </>,
      { instance: createFakeOrbitID({ loaded: true }) },
    );

    fireEvent.click(screen.getByText("run"));
    await waitFor(() => expect(results).toEqual(["ok:value"]));
    expect(onShow).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("opens the modal and retries once the user verifies", async () => {
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw reverificationError();
      return "value";
    });
    const onShow = vi.fn();
    const results: string[] = [];

    renderWithProvider(
      <>
        <Modal answer onShow={onShow} />
        <Probe fetcher={fetcher} onResult={(result) => results.push(result)} />
      </>,
      { instance: createFakeOrbitID({ loaded: true }) },
    );

    fireEvent.click(screen.getByText("run"));
    await waitFor(() => expect(results).toEqual(["ok:value"]));
    expect(onShow).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rethrows the original error when the user cancels", async () => {
    const fetcher = vi.fn(async () => {
      throw reverificationError();
    });
    const results: string[] = [];

    renderWithProvider(
      <>
        <Modal answer={false} />
        <Probe fetcher={fetcher} onResult={(result) => results.push(result)} />
      </>,
      { instance: createFakeOrbitID({ loaded: true }) },
    );

    fireEvent.click(screen.getByText("run"));
    await waitFor(() => expect(results).toHaveLength(1));
    expect(results[0]).toContain("session_reverification_required");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("resolves undefined on cancel when throwOnCancel is false", async () => {
    const fetcher = vi.fn(async () => {
      throw reverificationError();
    });
    const results: string[] = [];

    renderWithProvider(
      <>
        <Modal answer={false} />
        <Probe fetcher={fetcher} onResult={(result) => results.push(result)} throwOnCancel={false} />
      </>,
      { instance: createFakeOrbitID({ loaded: true }) },
    );

    fireEvent.click(screen.getByText("run"));
    await waitFor(() => expect(results).toEqual(["ok:undefined"]));
  });

  it("fails with an actionable message when no modal is mounted", async () => {
    const fetcher = vi.fn(async () => {
      throw reverificationError();
    });
    const results: string[] = [];

    renderWithProvider(
      <Probe fetcher={fetcher} onResult={(result) => results.push(result)} />,
      { instance: createFakeOrbitID({ loaded: true }) },
    );

    fireEvent.click(screen.getByText("run"));
    await waitFor(() => expect(results).toHaveLength(1));
    expect(results[0]).toContain("UserVerificationModal");
  });
});
