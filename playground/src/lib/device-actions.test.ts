import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearDeviceFlow, getDeviceFlow, rememberDeviceFlow } from "./device-flow";

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (path: string) => revalidatePath(path) }));

const listApplications = vi.fn();
vi.mock("@orbitid/backend", () => ({
  createOrbitIdClient: () => ({ oauthApplications: { getOAuthApplicationList: listApplications } }),
}));

vi.mock("@/lib/env", () => ({
  readSecretKey: () => process.env.ORBITID_SECRET_KEY ?? null,
  resolveApiUrl: () => "http://localhost:4000",
  currentOrigin: async () => "http://localhost:3300",
  createBackend: () => ({
    oauthApplications: {
      getOAuthApplicationList: listApplications,
      createOAuthApplication: async (params: Record<string, unknown>) => ({
        id: "oa_1",
        name: params.name,
        clientId: "oa_client",
        public: true,
        scopes: "openid",
      }),
    },
  }),
}));

const { pollDeviceFlow, startDeviceFlow, listDeviceApplications, resetDeviceFlow } = await import(
  "../app/device/actions"
);

const form = (entries: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
};

const DEVICE_RESPONSE = {
  device_code: "odc_1",
  user_code: "BCDF-2345",
  verification_uri: "http://localhost:4000/oauth/device",
  verification_uri_complete: "http://localhost:4000/oauth/device?user_code=BCDF-2345",
  expires_in: 600,
  interval: 5,
};

const record = () => ({
  deviceCode: DEVICE_RESPONSE.device_code,
  userCode: DEVICE_RESPONSE.user_code,
  verificationUri: DEVICE_RESPONSE.verification_uri,
  verificationUriComplete: DEVICE_RESPONSE.verification_uri_complete,
  expiresIn: DEVICE_RESPONSE.expires_in,
  interval: DEVICE_RESPONSE.interval,
  applicationId: "oa_1",
  clientId: "oa_client",
  applicationName: "CLI",
  scopes: "openid",
  startedAt: Date.now(),
  polls: [],
});

describe("device flow server actions", () => {
  beforeEach(() => {
    clearDeviceFlow();
    revalidatePath.mockReset();
    listApplications.mockReset();
    process.env.ORBITID_SECRET_KEY = "sk_test_playground";
    vi.restoreAllMocks();
  });

  it("lists applications from the Backend API", async () => {
    listApplications.mockResolvedValue({
      data: [{ id: "oa_1", name: "CLI", clientId: "oa_client", public: true, scopes: "openid" }],
    });
    const result = await listDeviceApplications();
    expect(result).toEqual({
      ok: true,
      applications: [{ id: "oa_1", name: "CLI", clientId: "oa_client", public: true, scopes: "openid" }],
    });
  });

  it("reports the missing secret key instead of calling the API", async () => {
    delete process.env.ORBITID_SECRET_KEY;
    const result = await listDeviceApplications();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ORBITID_SECRET_KEY");
  });

  it("starts a request and keeps the device code on the server", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      calls.push({ url: String(input), body: String(init?.body ?? "") });
      return new Response(JSON.stringify(DEVICE_RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const result = await startDeviceFlow(
      { ok: false, message: "" },
      form({ clientId: "oa_client", applicationId: "oa_1", applicationName: "CLI", scopes: "openid" }),
    );

    expect(result.ok).toBe(true);
    expect(result.message).toContain("BCDF-2345");
    expect(result.href).toBe(DEVICE_RESPONSE.verification_uri_complete);
    expect(calls[0]?.url).toBe("http://localhost:4000/oauth/device_authorization");
    expect(calls[0]?.body).toContain("client_id=oa_client");

    const flow = getDeviceFlow();
    expect(flow?.deviceCode).toBe("odc_1");
    expect(flow?.userCode).toBe("BCDF-2345");
    expect(revalidatePath).toHaveBeenCalledWith("/device");
  });

  it("explains a 404 as the grant being off", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ errors: [{ code: "resource_not_found" }] }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const result = await startDeviceFlow({ ok: false, message: "" }, form({ clientId: "oa_client" }));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("device grant is off");
  });

  it("asks for an application when no client id was sent", async () => {
    const result = await startDeviceFlow({ ok: false, message: "" }, form({}));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Choose an application");
  });

  it("records a pending poll and keeps the code", async () => {
    rememberDeviceFlow(record());
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      calls.push(String(init?.body ?? ""));
      return new Response(
        JSON.stringify({ error: "authorization_pending", error_description: "Not yet" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    });

    const result = await pollDeviceFlow({ ok: false, message: "" }, form({}));
    expect(result.message).toContain("Waiting for the code");
    expect(calls[0]).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code");
    expect(calls[0]).toContain("device_code=odc_1");
    expect(getDeviceFlow()?.polls.at(-1)?.state).toBe("pending");
  });

  it("returns the token set once the code is approved", async () => {
    rememberDeviceFlow(record());
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "oat_1",
            token_type: "Bearer",
            expires_in: 3600,
            scope: "openid email",
            refresh_token: "ort_1",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const result = await pollDeviceFlow({ ok: false, message: "" }, form({}));
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Approved");
    expect(result.detail).toContain("A refresh token came with it");
    expect(result.secret).toBe("oat_1");
    expect(getDeviceFlow()?.polls.at(-1)?.state).toBe("complete");
  });

  it("refuses to poll without a request in progress", async () => {
    const result = await pollDeviceFlow({ ok: false, message: "" }, form({}));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("No device request");
  });

  it("clears the request", async () => {
    rememberDeviceFlow(record());
    const result = await resetDeviceFlow({ ok: false, message: "" }, form({}));
    expect(result.ok).toBe(true);
    expect(getDeviceFlow()).toBeNull();
  });
});
