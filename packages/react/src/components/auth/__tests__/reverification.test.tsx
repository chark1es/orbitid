import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { UserVerificationModal, UserProfile } from "../index";
import { useReverification } from "../../../hooks";
import { renderAuth, setupAuth } from "./fake-auth";

function SensitiveAction() {
  const [result, setResult] = useState("");
  const fetcher = vi.fn()
    .mockRejectedValueOnce({ errors: [{ code: "session_reverification_required", message: "Verify" }] })
    .mockResolvedValueOnce("saved");
  const run = useReverification(fetcher);
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          void run().then((value) => setResult(String(value)));
        }}
      >
        Sensitive action
      </button>
      <p>{result}</p>
    </div>
  );
}

describe("reverification", () => {
  it("opens the modal after a reverification error and retries the action", async () => {
    const harness = setupAuth();
    const verification = {
      status: "unverified",
      strategy: "password",
      attemptFirstFactor: vi.fn(async () => ({ status: "verified", strategy: "password" })),
      prepareFirstFactor: vi.fn(async () => ({ status: "unverified", strategy: "email_code" })),
      attemptSecondFactor: vi.fn(async () => ({ status: "verified", strategy: "totp" })),
    };
    harness.instance.session = {
      ...harness.instance.session!,
      startVerification: vi.fn(async () => verification),
    } as never;
    harness.instance.emit();

    renderAuth(
      <>
        <SensitiveAction />
        <UserVerificationModal />
      </>,
      harness,
    );

    fireEvent.click(screen.getByRole("button", { name: "Sensitive action" }));
    expect(await screen.findByText("Verify your identity")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: "hunter2" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() => expect(verification.attemptFirstFactor).toHaveBeenCalledWith({
      strategy: "password",
      password: "hunter2",
    }));
    await waitFor(() => expect(screen.getByText("saved")).toBeTruthy());
  });

  it("is mounted by UserProfile", async () => {
    const harness = setupAuth();
    renderAuth(<UserProfile routing="virtual" />, harness);
    expect((await screen.findAllByText("Profile")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Verify your identity")).toBeNull();
  });
});
