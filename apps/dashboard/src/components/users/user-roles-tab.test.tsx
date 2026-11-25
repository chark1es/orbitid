import { expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { UserJSON, UserRolesJSON } from "@orbitid/shared";
import { UserRolesTab } from "./user-roles-tab";
import { mockApi, renderPage, type ApiCall } from "../../pages/_config/__tests__/harness";

const assignment = (roles: string[], source: UserRolesJSON["source"], defaultRole: string | null = null): UserRolesJSON => ({
  object: "user_roles", user_id: "user_1", roles, role_permissions: [], source, default_role: defaultRole,
});

function setup(initial: UserRolesJSON, afterReset?: UserRolesJSON) {
  let current = initial;
  return mockApi({ handle: (call: ApiCall) => {
    if (call.url.includes("/v1/roles") && call.method === "GET") return Response.json({ data: [
      { id: "role_support", key: "app:support", name: "Support" },
      { id: "role_member", key: "app:member", name: "Member" },
      { id: "role_admin", key: "org:admin", name: "Organization admin" },
    ], total_count: 3 });
    if (call.url.includes("/v1/users/user_1/roles")) {
      if (call.method === "DELETE" && afterReset) current = afterReset;
      if (call.method === "PUT") current = assignment((call.body?.roles as string[]) ?? [], "assigned", initial.default_role);
      return Response.json(current);
    }
  } });
}

it("assigns instance roles through the dedicated endpoint and never offers organization roles", async () => {
  const calls = setup(assignment(["app:member"], "assigned"));
  renderPage(<UserRolesTab user={{ id: "user_1", roles: ["app:member"] } as UserJSON} />);
  fireEvent.click(await screen.findByRole("checkbox", { name: /Support/ }));
  expect(screen.queryByRole("checkbox", { name: /Organization admin/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Save roles" }));
  await waitFor(() => expect(calls.find((call) => call.method === "PUT")).toMatchObject({ url: expect.stringContaining("/v1/users/user_1/roles"), body: { roles: ["app:member", "app:support"] } }));
});

it("marks roles inherited from the instance default and offers no reset", async () => {
  setup(assignment(["app:member"], "default", "app:member"));
  renderPage(<UserRolesTab user={{ id: "user_1", roles: ["app:member"] } as UserJSON} />);
  expect(await screen.findByText("Inherited from default")).toBeTruthy();
  expect(screen.getByRole("checkbox", { name: /Member \(default\)/ }).getAttribute("aria-checked")).toBe("true");
  expect(screen.queryByRole("button", { name: /Reset to default/ })).toBeNull();
  // Saving pins the roles: the copy says so before the operator saves.
  expect(screen.getByText(/this user will stop following the default/)).toBeTruthy();
});

it("tells the operator that guests don't inherit the default role", async () => {
  setup(assignment([], "default", "app:member"));
  renderPage(<UserRolesTab user={{ id: "user_1", roles: [] as string[], is_anonymous: true } as UserJSON} />);
  expect(await screen.findByText("Guest: no default")).toBeTruthy();
  expect(screen.getByText(/Guests don't inherit the default role/)).toBeTruthy();
  expect(screen.queryByText("Inherited from default")).toBeNull();
  expect(screen.queryByRole("checkbox", { name: /\(default\)/ })).toBeNull();
});

it("resets an explicit assignment back to the instance default", async () => {
  const calls = setup(assignment([], "assigned", "app:member"), assignment(["app:member"], "default", "app:member"));
  renderPage(<UserRolesTab user={{ id: "user_1", roles: [] as string[] } as UserJSON} />);
  expect(await screen.findByText("Assigned")).toBeTruthy();
  expect(screen.getByText(/explicitly has no instance roles/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Reset to default (app:member)" }));
  await waitFor(() => expect(calls.some((call) => call.method === "DELETE" && call.url.includes("/v1/users/user_1/roles"))).toBe(true));
  expect(await screen.findByText("Inherited from default")).toBeTruthy();
});
