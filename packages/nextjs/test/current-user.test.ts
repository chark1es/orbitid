import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestKeys, signTestToken } from "./helpers";

const { getUser, createOrbitIdClient, headerStore } = vi.hoisted(() => ({
  getUser: vi.fn(),
  createOrbitIdClient: vi.fn(),
  headerStore: new Map<string, string>(),
}));

vi.mock("@orbitid/backend", () => ({
  createOrbitIdClient: (...args: unknown[]) => {
    createOrbitIdClient(...args);
    return { users: { getUser } };
  },
}));

vi.mock("next/headers", () => ({
  headers: () => new Headers(Array.from(headerStore)),
}));

import { currentUser } from "../src/server-client";
import { orbitIdClient } from "../src/backend-client";

beforeEach(async () => {
  process.env.ORBITID_JWT_KEY = (await getTestKeys()).publicKeyPem;
  headerStore.clear();
  getUser.mockReset();
  createOrbitIdClient.mockReset();
  process.env.ORBITID_SECRET_KEY = "sk_test_secret";
  process.env.NEXT_PUBLIC_ORBITID_API_URL = "http://localhost:4000";
});

afterEach(() => {
  delete process.env.ORBITID_SECRET_KEY;
  delete process.env.NEXT_PUBLIC_ORBITID_API_URL;
});

describe("currentUser()", () => {
  it("fetches the signed-in user from the Backend API", async () => {
    const token = await signTestToken({ sub: "user_1" });
    headerStore.set("x-orbitid-auth-status", "signed-in");
    headerStore.set("x-orbitid-auth-token", token);
    const user = { id: "user_1", firstName: "Ada", primaryEmailAddressId: "idn_1" };
    getUser.mockResolvedValue(user);

    await expect(currentUser()).resolves.toEqual(user);
    expect(getUser).toHaveBeenCalledWith("user_1");
    expect(createOrbitIdClient).toHaveBeenCalledWith({
      secretKey: "sk_test_secret",
      apiUrl: "http://localhost:4000",
    });
  });

  it("returns null without querying the Backend API when signed out", async () => {
    headerStore.set("x-orbitid-auth-status", "signed-out");
    await expect(currentUser()).resolves.toBeNull();
    expect(getUser).not.toHaveBeenCalled();
  });

  it("passes Backend API errors through", async () => {
    headerStore.set("x-orbitid-auth-status", "signed-in");
    headerStore.set("x-orbitid-auth-token", await signTestToken());
    getUser.mockRejectedValue(new Error("user_not_found"));
    await expect(currentUser()).rejects.toThrow("user_not_found");
  });
});

describe("orbitIdClient()", () => {
  it("is a singleton per API URL + secret key", () => {
    const first = orbitIdClient();
    const second = orbitIdClient();
    expect(first).toBe(second);
  });

  it("throws a clear error without a secret key", () => {
    delete process.env.ORBITID_SECRET_KEY;
    expect(() => orbitIdClient()).toThrow(/ORBITID_SECRET_KEY/);
  });
});
