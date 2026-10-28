import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTestKeys, signTestToken } from "./helpers";

const { getToken, headerStore } = vi.hoisted(() => ({
  getToken: vi.fn(),
  headerStore: new Map<string, string>(),
}));

vi.mock("@orbitid/backend", () => ({
  createOrbitIdClient: () => ({
    users: { getUser: vi.fn() },
    sessions: { getToken },
  }),
}));

vi.mock("next/headers", () => ({
  headers: () => new Headers(Array.from(headerStore)),
}));

vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("NEXT_REDIRECT");
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import { auth } from "../src/server-auth";

beforeEach(async () => {
  process.env.ORBITID_JWT_KEY = (await getTestKeys()).publicKeyPem;
  headerStore.clear();
  getToken.mockReset();
  process.env.ORBITID_SECRET_KEY = "sk_test_secret";
});

describe("auth().getToken()", () => {
  it("returns the __session token by default", async () => {
    const token = await signTestToken({ sid: "sess_1" });
    headerStore.set("x-orbitid-auth-status", "signed-in");
    headerStore.set("x-orbitid-auth-token", token);
    const session = await auth();
    await expect(session.getToken()).resolves.toBe(token);
    expect(getToken).not.toHaveBeenCalled();
  });

  it("mints custom JWT templates through the Backend API", async () => {
    headerStore.set("x-orbitid-auth-status", "signed-in");
    headerStore.set("x-orbitid-auth-token", await signTestToken({ sid: "sess_42" }));
    getToken.mockResolvedValue({ jwt: "template-token" });

    const session = await auth();
    await expect(session.getToken({ template: "hasura" })).resolves.toBe("template-token");
    expect(getToken).toHaveBeenCalledWith("sess_42", { template: "hasura" });
  });

  it("returns null for templates when signed out", async () => {
    headerStore.set("x-orbitid-auth-status", "signed-out");
    const session = await auth();
    await expect(session.getToken({ template: "hasura" })).resolves.toBeNull();
    expect(getToken).not.toHaveBeenCalled();
  });
});
