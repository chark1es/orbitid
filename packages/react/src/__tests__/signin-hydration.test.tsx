import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { useSignIn, useSignUp } from "../hooks";
import { createFakeOrbitID, renderWithProvider, sessionClaims } from "./helpers";

function Probe() {
  const { isLoaded: signInLoaded, signIn } = useSignIn();
  const { isLoaded: signUpLoaded, signUp } = useSignUp();
  return <div data-testid="probe">{`${signInLoaded}:${Boolean(signIn)}:${signUpLoaded}:${Boolean(signUp)}`}</div>;
}

describe("useSignIn / useSignUp with SSR initialState", () => {
  it("stay unloaded until the instance itself has loaded, so attempts cannot race the first client fetch", async () => {
    const instance = createFakeOrbitID({ loaded: false });
    let release!: () => void;
    instance.loadGate = new Promise<void>((resolve) => (release = resolve));
    renderWithProvider(<Probe />, {
      instance,
      providerProps: { initialState: { userId: "user_1", sessionId: "sess_1", sessionClaims: sessionClaims({ sub: "user_1", sid: "sess_1" }) } },
    });

    expect(screen.getByTestId("probe").textContent).toBe("false:false:false:false");
    release();
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("true:true:true:true"));
  });
});
