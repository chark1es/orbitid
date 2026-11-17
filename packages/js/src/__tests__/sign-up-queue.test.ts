import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OrbitID } from "../orbit";
import { ApiMock, clearCookies, clientJSON, environmentJSON, publishableKey, signUpJSON } from "./helpers";

describe("SignUp mutation queue", () => {
  beforeEach(() => clearCookies());
  afterEach(() => clearCookies());

  it("never sends two updates for one attempt at the same time", async () => {
    let signUp = signUpJSON();
    let client = clientJSON();
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let patchCalls = 0;

    const api = new ApiMock(async (call) => {
      if (call.method === "GET" && call.path === "/v1/client") return { body: { response: client, client } };
      if (call.method === "GET" && call.path === "/v1/client/environment") {
        return { body: { response: environmentJSON() } };
      }
      if (call.method === "POST" && call.path === "/v1/client/sign_ups") {
        signUp = signUpJSON({ status: "missing_requirements", email_address: "new@example.com" });
        client = clientJSON({ sign_up: signUp });
        return { body: { response: signUp, client } };
      }
      if (call.method === "PATCH" && call.path === "/v1/client/sign_ups/sua_1") {
        patchCalls += 1;
        if (patchCalls === 1) await firstGate;
        signUp = signUpJSON({ ...signUp, first_name: (call.body?.first_name as string) ?? signUp.first_name });
        client = clientJSON({ sign_up: signUp });
        return { body: { response: signUp, client } };
      }
      return { status: 404, body: { errors: [{ code: "resource_not_found", message: call.path }] } };
    });

    const orbit = new OrbitID(publishableKey, { fetch: api.fetch });
    await orbit.load();
    const signUpResource = orbit.signUp;
    await signUpResource.create({ emailAddress: "new@example.com", password: "super-secret-1" });

    const first = signUpResource.update({ firstName: "Ada" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = signUpResource.update({ lastName: "Lovelace" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The second PATCH must wait for the first, so the server never sees two
    // updates built from the same version (which one would answer with
    // `client_state_invalid`).
    expect(api.countCalls("PATCH", "/v1/client/sign_ups/sua_1")).toBe(1);

    releaseFirst();
    await Promise.all([first, second]);
    expect(api.countCalls("PATCH", "/v1/client/sign_ups/sua_1")).toBe(2);
    orbit.dispose();
  });
});
