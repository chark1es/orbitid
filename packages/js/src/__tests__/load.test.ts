import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OrbitID } from "../orbit";
import { clientJSON, clearCookies, cookieValue, environmentJSON, fakeJwt, publishableKey, sessionJSON, userJSON, ApiMock } from "./helpers";

describe("OrbitID.load", () => {
  beforeEach(() => clearCookies());
  afterEach(() => clearCookies());

  function setup(overrides: { client?: ReturnType<typeof clientJSON> } = {}) {
    const token = fakeJwt({ sid: "sess_1", org_id: "org_1" });
    const client = overrides.client ?? clientJSON({ sessions: [sessionJSON()], last_active_session_id: "sess_1" });
    const api = new ApiMock((call) => {
      if (call.method === "GET" && call.path === "/v1/client") return { body: { response: client, client } };
      if (call.method === "GET" && call.path === "/v1/client/environment") return { body: { response: environmentJSON() } };
      if (call.method === "POST" && call.path === "/v1/client/sessions/sess_1/tokens") return { body: { jwt: token } };
      return { status: 404, body: { errors: [{ code: "resource_not_found", message: `unexpected ${call.method} ${call.path}` }] } };
    });
    const orbit = new OrbitID(publishableKey, { fetch: api.fetch });
    return { orbit, api, token, client };
  }

  it("loads client + environment, exposes resources and writes cookies", async () => {
    const { orbit, api, token } = setup();
    expect(orbit.loaded).toBe(false);
    expect(orbit.isSignedIn).toBe(false);

    await orbit.load();

    expect(orbit.loaded).toBe(true);
    expect(orbit.isSignedIn).toBe(true);
    expect(orbit.client?.id).toBe("client_1");
    expect(orbit.session?.id).toBe("sess_1");
    expect(orbit.user?.firstName).toBe("Ada");
    expect(orbit.user?.fullName).toBe("Ada Lovelace");
    expect(orbit.session?.publicUserData?.userId).toBe("user_1");
    expect(orbit.session?.publicUserData?.identifier).toBe("ada@example.com");
    expect(orbit.environment?.displayConfig.applicationName).toBe("Acme App");
    expect(orbit.environment?.userSettings.passwordSettings.minLength).toBe(10);
    expect(orbit.organization).toBeNull();

    expect(cookieValue("__session")).toBe(token);
    expect(Number(cookieValue("__client_uat"))).toBeGreaterThan(0);

    const clientCall = api.lastCall("GET", "/v1/client");
    expect(clientCall?.headers["x-orbitid-client"]).toMatch(/^@orbitid\/js\//);
    expect(clientCall?.init.credentials).toBe("include");

    orbit.dispose();
  });

  it("notifies listeners once per load and only re-emits on state changes", async () => {
    const { orbit } = setup();
    const states: unknown[] = [];
    const unsubscribe = orbit.addListener((state) => states.push(state));

    await orbit.load();
    expect(states).toHaveLength(1);
    expect((states[0] as { user: { id: string } }).user.id).toBe("user_1");

    await orbit.load();
    expect(states).toHaveLength(1);

    unsubscribe();
    await orbit.load();
    expect(states).toHaveLength(1);
    orbit.dispose();
  });

  it("keeps sessions offline-safe: no token request when signed out", async () => {
    const api = new ApiMock((call) => {
      if (call.method === "GET" && call.path === "/v1/client") {
        const client = clientJSON();
        return { body: { response: client, client } };
      }
      if (call.method === "GET" && call.path === "/v1/client/environment") return { body: { response: environmentJSON() } };
      return { status: 500, body: { errors: [{ code: "unexpected", message: call.path }] } };
    });
    const orbit = new OrbitID(publishableKey, { fetch: api.fetch });
    await orbit.load();
    expect(api.countCalls("POST", "/v1/client/sessions/sess_1/tokens")).toBe(0);
    expect(cookieValue("__session")).toBeNull();
    expect(cookieValue("__client_uat")).toBe("0");
    orbit.dispose();
  });

  it("refreshClient replaces resources with fresh references", async () => {
    let name = "Ada";
    const client = () => clientJSON({ sessions: [sessionJSON({ user: userJSON({ first_name: name }) })], last_active_session_id: "sess_1" });
    const api = new ApiMock((call) => {
      if (call.method === "GET" && call.path === "/v1/client") return { body: { response: client() } };
      if (call.method === "GET" && call.path === "/v1/client/environment") return { body: { response: environmentJSON() } };
      if (call.path === "/v1/client/sessions/sess_1/tokens") return { body: { jwt: fakeJwt() } };
      return { status: 404, body: {} };
    });
    const orbit = new OrbitID(publishableKey, { fetch: api.fetch });
    await orbit.load();
    const previousUser = orbit.user;
    name = "Grace";
    await orbit.refreshClient();
    expect(orbit.user?.firstName).toBe("Grace");
    expect(orbit.user).not.toBe(previousUser);
    orbit.dispose();
  });
});
