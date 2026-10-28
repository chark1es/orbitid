import { StrictMode } from "react";
import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { OrbitIDFailed, OrbitIDLoaded, OrbitIDLoading } from "../control";
import { useAuth } from "../hooks/useAuth";
import { OrbitIDProvider } from "../provider/OrbitIDProvider";
import { createServerOrbitID, getOrbitIDInstance, resetOrbitIDInstances } from "../provider/instance";
import {
  createFakeOrbitID,
  fakeSession,
  fakeUser,
  makeJwt,
  PK,
  renderWithProvider,
  sessionClaims,
} from "./helpers";

function AuthProbe() {
  const { isLoaded, isSignedIn, userId, orgRole, sessionStatus, has } = useAuth();
  return (
    <p data-testid="auth">
      {[isLoaded, String(isSignedIn), userId ?? "none", orgRole ?? "none", sessionStatus ?? "none", has({ role: "org:admin" })].join(
        ":",
      )}
    </p>
  );
}

describe("<OrbitIDProvider/>", () => {
  it("loads the instance once and re-renders on listener events", async () => {
    const instance = createFakeOrbitID({ loaded: false });
    let finishLoad: () => void = () => {};
    instance.load = () => {
      instance.loadCalls += 1;
      return new Promise<void>((resolve) => {
        finishLoad = () => {
          instance.loaded = true;
          instance.emit();
          resolve();
        };
      });
    };

    const { unmount } = renderWithProvider(<AuthProbe />, { instance });

    expect(screen.getByTestId("auth").textContent).toBe("false:undefined:none:none:none:false");
    expect(instance.loadCalls).toBe(1);

    await act(async () => finishLoad());
    await waitFor(() => expect(screen.getByTestId("auth").textContent).toBe("true:false:none:none:none:false"));
    expect(instance.listenerCount()).toBe(1);

    act(() => {
      instance.setAuth(
        fakeSession({
          lastActiveToken: { object: "token", jwt: makeJwt(sessionClaims({ org_role: "org:admin", org_id: "org_1" })) },
        }),
        fakeUser(),
      );
    });

    await waitFor(() =>
      expect(screen.getByTestId("auth").textContent).toBe("true:true:user_1:org:admin:active:true"),
    );

    unmount();
    expect(instance.listenerCount()).toBe(0);
  });

  it("survives StrictMode double effects without a second load or instance", async () => {
    const instance = createFakeOrbitID({ loaded: false });
    render(
      <StrictMode>
        <OrbitIDProvider publishableKey={PK} orbit={instance}>
          <AuthProbe />
        </OrbitIDProvider>
      </StrictMode>,
    );

    await waitFor(() => expect(instance.loaded).toBe(true));
    expect(instance.loadCalls).toBe(1);
  });

  it("renders initialState on the very first render (SSR hydration)", async () => {
    const instance = createFakeOrbitID({ loaded: false });
    renderWithProvider(<AuthProbe />, {
      instance,
      providerProps: {
        initialState: {
          userId: "user_9",
          sessionId: "sess_9",
          orgId: "org_1",
          orgRole: "org:admin",
          sessionClaims: sessionClaims({ sub: "user_9", sid: "sess_9", org_role: "org:admin" }),
        },
      },
    });

    expect(screen.getByTestId("auth").textContent).toBe("true:true:user_9:org:admin:none:true");
    await waitFor(() => expect(instance.loadCalls).toBe(1));
  });

  it("surfaces load failures and retries on demand", async () => {
    const instance = createFakeOrbitID({ loaded: false });
    instance.loadError = new Error("boom");

    renderWithProvider(
      <>
        <OrbitIDLoading>
          <p>loading</p>
        </OrbitIDLoading>
        <OrbitIDLoaded>
          <p>ready</p>
        </OrbitIDLoaded>
        <OrbitIDFailed />
      </>,
      { instance },
    );

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("boom"));
    expect(screen.queryByText("ready")).toBeNull();

    instance.loadError = null;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(instance.loadCalls).toBe(2));
    await waitFor(() => expect(screen.getByText("ready")).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("requires a publishableKey when no instance is injected", () => {
    expect(() =>
      render(
        <OrbitIDProvider publishableKey="">
          <div />
        </OrbitIDProvider>,
      ),
    ).toThrow(/publishableKey/);
  });

  it("exposes a server placeholder that refuses browser-only calls", () => {
    const placeholder = createServerOrbitID(PK);
    expect(placeholder.loaded).toBe(false);
    expect(placeholder.session).toBeNull();
    expect(placeholder.environment).toBeNull();
    expect(() => placeholder.setActive({})).toThrow(/not available on the server/);
  });

  it("reuses one instance per publishable key", () => {
    resetOrbitIDInstances();
    const first = getOrbitIDInstance(PK);
    const second = getOrbitIDInstance(PK);
    expect(second).toBe(first);
    resetOrbitIDInstances();
  });
});
