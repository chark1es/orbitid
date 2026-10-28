import { useState } from "react";
import { describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useAuth } from "../hooks/useAuth";
import { useOrganization } from "../hooks/useOrganization";
import { useOrganizationList } from "../hooks/useOrganizationList";
import { useSession } from "../hooks/useSession";
import { useSessionList } from "../hooks/useSessionList";
import { useSignIn } from "../hooks/useSignIn";
import { useSignUp } from "../hooks/useSignUp";
import { useUser } from "../hooks/useUser";
import {
  createFakeOrbitID,
  fakeMembership,
  fakeOrganization,
  fakeSession,
  fakeUser,
  makeJwt,
  renderWithProvider,
  sessionClaims,
} from "./helpers";

function AuthSnapshot() {
  const auth = useAuth();
  return (
    <p data-testid="auth">
      {JSON.stringify({
        isLoaded: auth.isLoaded,
        isSignedIn: auth.isSignedIn,
        userId: auth.userId,
        sessionId: auth.sessionId,
        actor: auth.actor,
        orgId: auth.orgId,
        orgRole: auth.orgRole,
        orgSlug: auth.orgSlug,
        orgPermissions: auth.orgPermissions,
        sessionStatus: auth.sessionStatus,
        role: auth.has({ role: "org:admin" }),
        permission: auth.has({ permission: "org:sys_memberships:manage" }),
        reverification: auth.has({ reverification: "strict" }),
      })}
    </p>
  );
}

describe("useAuth", () => {
  it("projects session claims into the auth state shape", async () => {
    const jwt = makeJwt(
      sessionClaims({
        org_id: "org_7",
        org_role: "org:admin",
        org_permissions: ["org:sys_memberships:manage"],
        act: { sub: "admin_1" },
        fva: [2, 1],
      }),
    );
    const instance = createFakeOrbitID({
      loaded: true,
      session: fakeSession({
        lastActiveToken: { object: "token", jwt },
        lastActiveOrganizationId: "org_7",
      }),
      user: fakeUser(),
      organization: fakeOrganization({ id: "org_7", slug: "acme" }),
    });

    renderWithProvider(<AuthSnapshot />, { instance });
    await waitFor(() => expect(screen.getByTestId("auth").textContent).toContain('"orgRole":"org:admin"'));

    const value = JSON.parse(screen.getByTestId("auth").textContent!) as Record<string, unknown>;
    expect(value).toMatchObject({
      isLoaded: true,
      isSignedIn: true,
      userId: "user_1",
      sessionId: "sess_1",
      actor: { sub: "admin_1" },
      orgId: "org_7",
      orgRole: "org:admin",
      orgSlug: "acme",
      orgPermissions: ["org:sys_memberships:manage"],
      sessionStatus: "active",
      role: true,
      permission: true,
      reverification: true,
    });
  });

  it("exposes getToken and signOut wired to the instance", async () => {
    const session = fakeSession();
    const instance = createFakeOrbitID({ loaded: true, session, user: fakeUser() });

    function Actions() {
      const { getToken, signOut } = useAuth();
      const [token, setToken] = useState("none");
      return (
        <>
          <button onClick={() => void getToken().then((value) => setToken(value ?? "null"))}>token</button>
          <button onClick={() => void signOut()}>out</button>
          <span data-testid="token">{token}</span>
        </>
      );
    }

    renderWithProvider(<Actions />, { instance, providerProps: { afterSignOutUrl: "/bye" } });
    const expectedToken = await session.getToken();
    fireEvent.click(screen.getByText("token"));
    await waitFor(() => expect(screen.getByTestId("token").textContent).toBe(expectedToken));

    fireEvent.click(screen.getByText("out"));
    await waitFor(() => expect(instance.signOutCalls).toHaveLength(1));
    expect(instance.signOutCalls[0]?.redirectUrl).toBe("/bye");
  });

  it("treats a pending session as signed out unless asked not to", async () => {
    const instance = createFakeOrbitID({
      loaded: true,
      session: fakeSession({ status: "pending" }),
      user: fakeUser(),
    });

    function Probe() {
      const signedOut = useAuth();
      const signedIn = useAuth({ treatPendingAsSignedOut: false });
      const { session } = useSession();
      return (
        <p data-testid="pending">
          {String(signedOut.isSignedIn)}:{String(signedIn.isSignedIn)}:{signedOut.sessionStatus}:
          {session?.status}
        </p>
      );
    }

    renderWithProvider(<Probe />, { instance });
    expect(screen.getByTestId("pending").textContent).toBe("false:true:pending:pending");
  });
});

describe("resource hooks", () => {
  it("expose user, session, session list, sign-in and sign-up", async () => {
    const instance = createFakeOrbitID({
      loaded: true,
      session: fakeSession(),
      user: fakeUser(),
    });

    function Resources() {
      const { user, isSignedIn } = useUser();
      const { session } = useSession();
      const { sessions } = useSessionList();
      const { signIn } = useSignIn();
      const { signUp } = useSignUp();
      return (
        <p data-testid="resources">
          {JSON.stringify({
            fullName: user?.fullName,
            isSignedIn,
            sessionId: session?.id,
            sessions: sessions.length,
            signInStatus: signIn?.status,
            missingFields: signUp?.missingFields,
          })}
        </p>
      );
    }

    renderWithProvider(<Resources />, { instance });
    const value = JSON.parse(screen.getByTestId("resources").textContent!) as Record<string, unknown>;
    expect(value).toEqual({
      fullName: "Ada Lovelace",
      isSignedIn: true,
      sessionId: "sess_1",
      sessions: 1,
      signInStatus: "needs_identifier",
      missingFields: ["email_address"],
    });
  });

  it("exposes isAnonymous on useUser", () => {
    const instance = createFakeOrbitID({
      loaded: true,
      session: fakeSession(),
      user: fakeUser({ isAnonymous: true }),
    });

    function Probe() {
      const { isAnonymous, user } = useUser();
      return <p data-testid="anonymous">{JSON.stringify({ isAnonymous, id: user?.id })}</p>;
    }

    renderWithProvider(<Probe />, { instance });
    expect(JSON.parse(screen.getByTestId("anonymous").textContent!)).toMatchObject({ isAnonymous: true, id: "user_1" });
  });

  it("reports isAnonymous false for a regular account", () => {
    const instance = createFakeOrbitID({ loaded: true, session: fakeSession(), user: fakeUser() });

    function Probe() {
      const { isAnonymous } = useUser();
      return <p data-testid="anonymous">{String(isAnonymous)}</p>;
    }

    renderWithProvider(<Probe />, { instance });
    expect(screen.getByTestId("anonymous").textContent).toBe("false");
  });
});

describe("useOrganization", () => {
  it("paginates memberships and resolves the active membership", async () => {
    const members = [
      fakeMembership({ id: "m1", publicUserData: { user_id: "user_1" } }),
      fakeMembership({ id: "m2", publicUserData: { user_id: "user_2" } }),
      fakeMembership({ id: "m3", publicUserData: { user_id: "user_3" } }),
    ];
    const organization = fakeOrganization({ memberships: members });
    const instance = createFakeOrbitID({
      loaded: true,
      session: fakeSession(),
      user: fakeUser({}, members),
      organization,
    });

    function OrgProbe() {
      const { organization: org, membership, memberships, apiKeys } = useOrganization({
        memberships: { pageSize: 2 },
      });
      return (
        <>
          <p data-testid="org">{org?.slug ?? "none"}</p>
          <p data-testid="membership">{membership?.publicUserData.user_id ?? "none"}</p>
          <p data-testid="members">
            {JSON.stringify({
              ids: memberships.data.map((member) => member.publicUserData.user_id),
              count: memberships.count,
              page: memberships.page,
              pageCount: memberships.pageCount,
              hasNext: memberships.hasNextPage,
              hasPrev: memberships.hasPreviousPage,
            })}
          </p>
          <p data-testid="apiKeys">{String(apiKeys.isFetching)}</p>
          <button onClick={() => void memberships.fetchNext()}>next</button>
        </>
      );
    }

    renderWithProvider(<OrgProbe />, { instance });

    await waitFor(() =>
      expect(JSON.parse(screen.getByTestId("members").textContent!).ids).toEqual(["user_1", "user_2"]),
    );
    expect(JSON.parse(screen.getByTestId("members").textContent!)).toMatchObject({
      count: 3,
      page: 1,
      pageCount: 2,
      hasNext: true,
      hasPrev: false,
    });
    expect(screen.getByTestId("org").textContent).toBe("acme");
    await waitFor(() => expect(screen.getByTestId("membership").textContent).toBe("user_1"));
    expect(screen.getByTestId("apiKeys").textContent).toBe("false");

    fireEvent.click(screen.getByText("next"));
    await waitFor(() => expect(JSON.parse(screen.getByTestId("members").textContent!).ids).toEqual(["user_3"]));
    expect(JSON.parse(screen.getByTestId("members").textContent!)).toMatchObject({
      page: 2,
      hasNext: false,
      hasPrev: true,
    });
  });
});

describe("useOrganization membership", () => {
  it("reloads when the active organization changes", async () => {
    const membershipFor = (organizationId: string, id: string) =>
      fakeMembership({ id, organization: fakeOrganization({ id: organizationId }) });
    const user = fakeUser({}, [membershipFor("org_1", "ma"), membershipFor("org_2", "mb")]);
    const instance = createFakeOrbitID({
      loaded: true,
      session: fakeSession(),
      user,
      organization: fakeOrganization({ id: "org_1" }),
    });

    function Probe() {
      const { membership } = useOrganization();
      return <p data-testid="membership">{membership?.organization.id ?? "none"}</p>;
    }

    renderWithProvider(<Probe />, { instance });
    await waitFor(() => expect(screen.getByTestId("membership").textContent).toBe("org_1"));

    act(() => instance.setOrganization(fakeOrganization({ id: "org_2" })));
    await waitFor(() => expect(screen.getByTestId("membership").textContent).toBe("org_2"));
  });
});

describe("useOrganizationList", () => {
  it("lists memberships and delegates setActive/createOrganization to the instance", async () => {
    const members = [fakeMembership({ id: "m1" }), fakeMembership({ id: "m2" })];
    const instance = createFakeOrbitID({
      loaded: true,
      session: fakeSession(),
      user: fakeUser({}, members),
    });

    function ListProbe() {
      const { userMemberships, userInvitations, userSuggestions, setActive, createOrganization } =
        useOrganizationList();
      return (
        <>
          <p data-testid="count">{String(userMemberships.count)}</p>
          <p data-testid="invitations">{String(userInvitations.data.length)}</p>
          <p data-testid="suggestions">{String(userSuggestions.data.length)}</p>
          <button onClick={() => void setActive({ organization: "org_2" })}>switch</button>
          <button onClick={() => void createOrganization({ name: "New" })}>create</button>
        </>
      );
    }

    renderWithProvider(<ListProbe />, { instance });
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("2"));
    expect(screen.getByTestId("invitations").textContent).toBe("0");
    expect(screen.getByTestId("suggestions").textContent).toBe("0");

    fireEvent.click(screen.getByText("switch"));
    await waitFor(() => expect(instance.setActiveCalls).toHaveLength(1));
    expect(instance.setActiveCalls[0]?.organization).toBe("org_2");

    fireEvent.click(screen.getByText("create"));
    await waitFor(() => expect(instance.createOrganizationCalls).toHaveLength(1));
    expect(instance.createOrganizationCalls[0]?.name).toBe("New");
  });
});
