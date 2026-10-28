import { StrictMode, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import {
  AuthenticateWithRedirectCallback,
  MultisessionAppSupport,
  Protect,
  RedirectToCreateOrganization,
  RedirectToOrganizationProfile,
  RedirectToSignIn,
  RedirectToSignUp,
  RedirectToUserProfile,
  SignedIn,
  SignedOut,
} from "../control";
import { OrbitIDProvider } from "../provider/OrbitIDProvider";
import {
  createFakeOrbitID,
  fakeSession,
  fakeUser,
  makeJwt,
  PK,
  renderWithProvider,
  sessionClaims,
} from "./helpers";

const adminSession = () =>
  fakeSession({
    lastActiveToken: {
      object: "token",
      jwt: makeJwt(sessionClaims({ org_role: "org:admin", org_permissions: ["org:sys_memberships:manage"] })),
    },
  });

describe("control components", () => {
  it("gates children with SignedIn/SignedOut/Protect", async () => {
    const instance = createFakeOrbitID({ loaded: true, session: adminSession(), user: fakeUser() });
    renderWithProvider(
      <>
        <SignedIn>
          <p>signed-in</p>
        </SignedIn>
        <SignedOut>
          <p>signed-out</p>
        </SignedOut>
        <Protect role="org:admin">
          <p>admin</p>
        </Protect>
        <Protect permission="org:sys_memberships:manage">
          <p>permission</p>
        </Protect>
        <Protect role="org:member" fallback={<p>denied</p>}>
          <p>member</p>
        </Protect>
        <Protect condition={false} fallback={<p>conditional</p>}>
          <p>never</p>
        </Protect>
      </>,
      { instance },
    );

    await waitFor(() => expect(screen.getByText("signed-in")).toBeTruthy());
    expect(screen.queryByText("signed-out")).toBeNull();
    expect(screen.getByText("admin")).toBeTruthy();
    expect(screen.getByText("permission")).toBeTruthy();
    expect(screen.getByText("denied")).toBeTruthy();
    expect(screen.queryByText("member")).toBeNull();
    expect(screen.getByText("conditional")).toBeTruthy();
  });

  it("renders the fallback (not children) while loading", () => {
    const instance = createFakeOrbitID({ loaded: false });
    renderWithProvider(
      <Protect role="org:admin" fallback={<p>fallback</p>}>
        <p>protected</p>
      </Protect>,
      { instance },
    );
    expect(screen.getByText("fallback")).toBeTruthy();
    expect(screen.queryByText("protected")).toBeNull();
  });
});

describe("redirect components", () => {
  it("redirects signed-out users to sign-in with a redirect_url", async () => {
    const instance = createFakeOrbitID({ loaded: true });
    renderWithProvider(<RedirectToSignIn />, { instance });

    await waitFor(() => expect(instance.navigations).toHaveLength(1));
    expect(instance.navigations[0]?.to).toBe(
      `/sign-in?redirect_url=${encodeURIComponent("http://localhost:3000/")}`,
    );
    expect(instance.buildSignInUrlCalls).toHaveLength(1);
  });

  it("falls back to routerReplace when the instance cannot navigate", async () => {
    const routerReplace = vi.fn();
    const instance = createFakeOrbitID({ loaded: true });
    Object.defineProperty(instance, "navigate", { value: undefined });

    renderWithProvider(<RedirectToSignUp />, { instance, providerProps: { routerReplace } });
    await waitFor(() => expect(routerReplace).toHaveBeenCalledTimes(1));
    expect(routerReplace.mock.calls[0]?.[0]).toBe(
      `/sign-up?redirect_url=${encodeURIComponent("http://localhost:3000/")}`,
    );
  });

  it("does nothing when the user is already signed in", async () => {
    const instance = createFakeOrbitID({ loaded: true, session: fakeSession(), user: fakeUser() });
    renderWithProvider(<RedirectToSignIn />, { instance });
    await waitFor(() => expect(instance.loaded).toBe(true));
    expect(instance.navigations).toHaveLength(0);
  });

  it("redirects signed-in users to their profile pages", async () => {
    const instance = createFakeOrbitID({ loaded: true, session: fakeSession(), user: fakeUser() });
    renderWithProvider(
      <>
        <RedirectToUserProfile />
        <RedirectToOrganizationProfile />
        <RedirectToCreateOrganization />
      </>,
      { instance },
    );

    await waitFor(() => expect(instance.navigations).toHaveLength(3));
    expect(instance.navigations.map((entry) => entry.to)).toEqual([
      "/user-profile",
      "/organization-profile",
      "/create-organization",
    ]);
  });

  it("completes the OAuth callback once, with provider fallbacks merged", async () => {
    const instance = createFakeOrbitID({ loaded: true });

    function Flow() {
      return (
        <StrictMode>
          <AuthenticateWithRedirectCallback signInForceRedirectUrl="/after" />
        </StrictMode>
      );
    }

    renderWithProvider(<Flow />, {
      instance,
      providerProps: { signInFallbackRedirectUrl: "/dashboard", signUpFallbackRedirectUrl: "/welcome" },
    });

    await waitFor(() => expect(instance.redirectCallbackCalls).toHaveLength(1));
    expect(instance.redirectCallbackCalls[0]).toMatchObject({
      signInForceRedirectUrl: "/after",
      signInFallbackRedirectUrl: "/dashboard",
      signUpFallbackRedirectUrl: "/welcome",
    });
  });
});

describe("MultisessionAppSupport", () => {
  it("remounts children when the active session changes", async () => {
    let mounts = 0;
    function Child() {
      const [instanceId] = useState(() => {
        mounts += 1;
        return mounts;
      });
      return <p data-testid="child">{String(instanceId)}</p>;
    }

    const instance = createFakeOrbitID({ loaded: true, session: fakeSession(), user: fakeUser() });
    render(
      <OrbitIDProvider publishableKey={PK} orbit={instance}>
        <MultisessionAppSupport>
          <Child />
        </MultisessionAppSupport>
      </OrbitIDProvider>,
    );

    expect(screen.getByTestId("child").textContent).toBe("1");
    act(() => instance.setAuth(fakeSession({ id: "sess_2" }), fakeUser()));
    await waitFor(() => expect(screen.getByTestId("child").textContent).toBe("2"));
  });
});
